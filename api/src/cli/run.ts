import { createCli } from './index.js';

let args = process.argv;

if (process.argv[1] && process.argv[1].includes('ProcessContainer.js')) {
    const directusCommand = process.argv[process.argv.length - 1] || '';
    args = [process.argv[0] || '', process.argv[1] || '', directusCommand];
}

createCli()
    .then((program) => program.parseAsync(args))
    .catch((err) => {
        // eslint-disable-next-line no-console
        console.error(err);
        process.exit(1);
    });
