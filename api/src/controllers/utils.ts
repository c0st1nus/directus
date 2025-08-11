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
					const fieldNamePriority = new Map<string, string>();
					const relationFieldPaths = new Map<string, string>();

					const discoverFields = async (collection: string, pathPrefix = '', visited = new Set<string>()) => {
						if (visited.has(collection)) {
							return;
						}

						visited.add(collection);

						const fields = await fieldsService.readAll(collection);

						for (const field of fields) {
							const currentPath = pathPrefix + field.field;
							const fieldNameLower = field.field.toLowerCase();

							// Main field name always has highest priority
							fieldNamePriority.set(fieldNameLower, currentPath);
							headerToPathMap.set(fieldNameLower, currentPath);

							// For related fields also store simple field name
							if (pathPrefix && pathPrefix.includes('.create.')) {
								relationFieldPaths.set(fieldNameLower, currentPath);

								// Add translations if available
								if (field.meta?.translations) {
									for (const translation of field.meta.translations) {
										if (translation.translation) {
											const translationLower = translation.translation.toLowerCase();
											relationFieldPaths.set(translationLower, currentPath);
										}
									}
								}
							}

							// Process field translations
							if (field.meta?.translations) {
								for (const translation of field.meta.translations) {
									if (translation.translation) {
										const translationLower = translation.translation.toLowerCase();

										// Translations have lower priority than field names
										if (!fieldNamePriority.has(translationLower)) {
											headerToPathMap.set(translationLower, currentPath);
										}
									}
								}
							}

							// Add full path (for cases when user uses full path)
							if (pathPrefix) {
								const lowerCurrentPath = currentPath.toLowerCase();
								headerToPathMap.set(lowerCurrentPath, currentPath);
							}

							if (field.meta?.special?.includes('m2o') || field.meta?.special?.includes('o2o')) {
								const relatedCollection = field.schema?.foreign_key_table;

								if (relatedCollection) {
									await discoverFields(relatedCollection, `${field.field}.`, new Set(visited));
								}
							} else if (field.meta?.special?.includes('o2m')) {
								const relation = req.schema.relations.find(
									(rel) => rel.related_collection === collection && rel.meta?.one_field === field.field,
								);

								if (relation?.collection) {
									// For o2m use .create. prefix so fields end up in relationFieldPaths
									await discoverFields(relation.collection, `${field.field}.create.`, new Set(visited));
								}
							}
						}
					};

					await discoverFields(req.params['collection']!);

					const setByPath = (obj: any, path: string, value: any) => {
						const keys = path.split('.');
						let current = obj;

						// Special handling for o2m relationships with create operations
						if (path.includes('.create.')) {
							const [relationField, createKey, ...remainingKeys] = keys;

							if (!relationField || createKey !== 'create') return;

							// Create structure for o2m relationship
							if (current[relationField] === undefined) {
								current[relationField] = { create: [{}], update: [], delete: [] };
							} else if (!current[relationField].create || !Array.isArray(current[relationField].create)) {
								current[relationField].create = [{}];
								if (!current[relationField].update) current[relationField].update = [];
								if (!current[relationField].delete) current[relationField].delete = [];
							} else if (current[relationField].create.length === 0) {
								current[relationField].create.push({});
							}

							// Set value in first element of create array
							let createCurrent = current[relationField].create[0];

							for (let i = 0; i < remainingKeys.length - 1; i++) {
								const key = remainingKeys[i]!;

								if (createCurrent[key] === undefined) {
									createCurrent[key] = {};
								}

								createCurrent = createCurrent[key];
							}

							createCurrent[remainingKeys[remainingKeys.length - 1]!] = value;
							return;
						}

						// Regular handling for normal fields (including m2o)
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
							let path: string | undefined;

							// First check main header map (main collection fields have priority)
							if (headerToPathMap.has(lowerHeader)) {
								path = headerToPathMap.get(lowerHeader)!;
							}
							// If not found in main collection, check related fields map
							else if (relationFieldPaths.has(lowerHeader)) {
								path = relationFieldPaths.get(lowerHeader)!;
							}

							if (path) {
								setByPath(newRow, path, row[header]);
							} else {
								// If field not found, keep as is (useful for debugging)
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
