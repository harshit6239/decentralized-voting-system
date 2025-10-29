const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

const DEFAULT_DB_PATH = "./data/ledger.db";
const DEFAULT_KEYS_DIR = "./src/keys";

const DB_PATH = process.env.DB_PATH || DEFAULT_DB_PATH;
const KEYS_DIR = process.env.KEYS_DIR || DEFAULT_KEYS_DIR;
const PORT_LEDGER = process.env.PORT_LEDGER;
const PORT_RA = process.env.PORT_RA;

const resolvePath = (targetPath) =>
    path.isAbsolute(targetPath)
        ? targetPath
        : path.resolve(process.cwd(), targetPath);

module.exports = {
    PORT_LEDGER,
    PORT_RA,
    DB_PATH,
    KEYS_DIR,
    resolved: {
        DB_PATH: resolvePath(DB_PATH),
        KEYS_DIR: resolvePath(KEYS_DIR),
    },
};
