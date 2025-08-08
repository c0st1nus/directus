import { InvalidPayloadError, InvalidQueryError, UnsupportedMediaTypeError } from '@directus/errors';
import argon2 from 'argon2';
import Busboy from 'busboy';
import { Router } from 'express';
import Joi from 'joi';
import collectionExists from '../middleware/collection-exists.js';
import { respond } from '../middleware/respond.js';
import { ExportService, ImportService } from '../services/import-export.js';
import { FieldsService } from '../services/fields.js';
import { RevisionsService } from '../services/revisions.js';
import { UtilsService } from '../services/utils.js';
import asyncHandler from '../utils/async-handler.js';
import { generateHash } from '../utils/generate-hash.js';
import { sanitizeQuery } from '../utils/sanitize-query.js';
import { Readable } from 'stream';
import * as XLSX from 'xlsx';

const router = Router();

const randomStringSchema = Joi.object<{ length: number }>({
	length: Joi.number().integer().min(1).max(500).default(32),
});

router.get(
	'/random/string',
	asyncHandler(async (req, res) => {
		const { nanoid } = await import('nanoid');

		const { error, value } = randomStringSchema.validate(req.query, { allowUnknown: true });

		if (error) throw new InvalidQueryError({ reason: error.message });

		return res.json({ data: nanoid(value.length) });
	}),
);

router.post(
	'/hash/generate',
	asyncHandler(async (req, res) => {
		if (!req.body?.string) {
			throw new InvalidPayloadError({ reason: `"string" is required` });
		}

		const hash = await generateHash(req.body.string);

		return res.json({ data: hash });
	}),
);

router.post(
	'/hash/verify',
	asyncHandler(async (req, res) => {
		if (!req.body?.string) {
			throw new InvalidPayloadError({ reason: `"string" is required` });
		}

		if (!req.body?.hash) {
			throw new InvalidPayloadError({ reason: `"hash" is required` });
		}

		try {
			const result = await argon2.verify(req.body.hash, req.body.string);
			return res.json({ data: result });
		} catch {
			throw new InvalidPayloadError({ reason: `Invalid "hash" or "string"` });
		}
	}),
);

const SortSchema = Joi.object({
	item: Joi.alternatives(Joi.string(), Joi.number()).required(),
	to: Joi.alternatives(Joi.string(), Joi.number()).required(),
});

router.post(
	'/sort/:collection',
	collectionExists,
	asyncHandler(async (req, res) => {
		const { error } = SortSchema.validate(req.body);
		if (error) throw new InvalidPayloadError({ reason: error.message });

		const service = new UtilsService({
			accountability: req.accountability,
			schema: req.schema,
		});

		await service.sort(req.collection, req.body);

		return res.status(200).end();
	}),
);

router.post(
	'/revert/:revision',
	asyncHandler(async (req, _res, next) => {
		const service = new RevisionsService({
			accountability: req.accountability,
			schema: req.schema,
		});

		await service.revert(req.params['revision']!);
		next();
	}),
	respond,
);

router.post(
	'/import/:collection',
	collectionExists,
	asyncHandler(async (req, res, next) => {
		if (req.is('multipart/form-data') === false) {
			throw new UnsupportedMediaTypeError({ mediaType: req.headers['content-type']!, where: 'Content-Type header' });
		}

		const service = new ImportService({
			accountability: req.accountability,
			schema: req.schema,
		});

		let headers;

		if (req.headers['content-type']) {
			headers = req.headers;
		} else {
			headers = {
				...req.headers,
				'content-type': 'application/octet-stream',
			};
		}

		const busboy = Busboy({ headers });

		busboy.on('file', async (_fieldname, fileStream, { mimeType }) => {
			try {
				if (
					mimeType === 'application/vnd.ms-excel' ||
					mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
				) {
					const chunks: any[] = [];

					for await (const chunk of fileStream) {
						chunks.push(chunk);
					}

					const buffer = Buffer.concat(chunks);

					const workbook = XLSX.read(buffer);
					const sheetName = workbook.SheetNames[0];

					if (!sheetName) {
						throw new InvalidPayloadError({ reason: 'Excel file contains no sheets.' });
					}

					const worksheet = workbook.Sheets[sheetName];

					if (!worksheet) {
						throw new InvalidPayloadError({ reason: 'Excel worksheet not found.' });
					}

					const jsonData: Record<string, any>[] = XLSX.utils.sheet_to_json(worksheet);
					const fieldsService = new FieldsService({ schema: req.schema, accountability: req.accountability });

					const headerToPathMap = new Map<string, string>();
					const conflicts = new Map<string, number>();

					const discoverFields = async (collection: string, pathPrefix = '', visited = new Set<string>()) => {
						if (visited.has(collection)) return;
						visited.add(collection);

						const fields = await fieldsService.readAll(collection);

						for (const field of fields) {
							const currentPath = pathPrefix + field.field;
							const potentialHeaders = [field.field];

							if (field.meta?.translations) {
								for (const translation of field.meta.translations) {
									if (translation.translation) {
										potentialHeaders.push(translation.translation);
									}
								}
							}

							for (const header of potentialHeaders) {
								const lowerHeader = header.toLowerCase();
								conflicts.set(lowerHeader, (conflicts.get(lowerHeader) ?? 0) + 1);
								headerToPathMap.set(lowerHeader, currentPath);
							}

							if (pathPrefix) {
								const lowerCurrentPath = currentPath.toLowerCase();
								headerToPathMap.set(lowerCurrentPath, currentPath);
							}

							if (field.meta?.special?.includes('m2o') || field.meta?.special?.includes('o2o')) {
								const relatedCollection = field.schema?.foreign_key_table;

								if (relatedCollection) {
									await discoverFields(relatedCollection, `${field.field}.`, new Set(visited));
								}
							}
						}
					};

					await discoverFields(req.params['collection']!);

					for (const [key, count] of conflicts.entries()) {
						if (count > 1) {
							headerToPathMap.delete(key);
						}
					}

					const setByPath = (obj: any, path: string, value: any) => {
						const keys = path.split('.');
						let current = obj;

						for (let i = 0; i < keys.length - 1; i++) {
							const key = keys[i]!;

							if (current[key] === undefined) {
								current[key] = {};
							}

							current = current[key];
						}

						current[keys[keys.length - 1]!] = value;
					};

					const transformedData: Record<string, any>[] = [];

					for (const row of jsonData) {
						const newRow: Record<string, any> = {};

						for (const header in row) {
							const lowerHeader = header.toLowerCase();

							if (headerToPathMap.has(lowerHeader)) {
								const path = headerToPathMap.get(lowerHeader)!;
								setByPath(newRow, path, row[header]);
							} else {
								newRow[header] = row[header];
							}
						}

						transformedData.push(newRow);
					}

					const jsonStream = Readable.from(JSON.stringify(transformedData));

					await service.import(req.params['collection']!, 'application/json', jsonStream);
				} else {
					await service.import(req.params['collection']!, mimeType, fileStream);
				}
			} catch (err: any) {
				if (err.code === 'Z_DATA_ERROR' || err.message.includes('corrupted')) {
					const chunks: any[] = [];

					for await (const chunk of fileStream) {
						chunks.push(chunk);
					}

					return next(new InvalidPayloadError({ reason: 'File is corrupted.' }));
				}

				return next(err);
			}

			return res.status(200).end();
		});

		busboy.on('error', (err: Error) => next(err));

		req.pipe(busboy);
	}),
);

router.post(
	'/export/:collection',
	collectionExists,
	asyncHandler(async (req, _res, next) => {
		if (!req.body.query) {
			throw new InvalidPayloadError({ reason: `"query" is required` });
		}

		if (!req.body.format) {
			throw new InvalidPayloadError({ reason: `"format" is required` });
		}

		const service = new ExportService({
			accountability: req.accountability,
			schema: req.schema,
		});

		const sanitizedQuery = await sanitizeQuery(req.body.query, req.schema, req.accountability ?? null);

		// We're not awaiting this, as it's supposed to run async in the background
		service.exportToFile(req.params['collection']!, sanitizedQuery, req.body.format, {
			file: req.body.file,
		});

		return next();
	}),
	respond,
);

router.post(
	'/cache/clear',
	asyncHandler(async (req, res) => {
		const service = new UtilsService({
			accountability: req.accountability,
			schema: req.schema,
		});

		const clearSystemCache = 'system' in req.query && (req.query['system'] === '' || Boolean(req.query['system']));

		await service.clearCache({ system: clearSystemCache });

		res.status(200).end();
	}),
);

export default router;
