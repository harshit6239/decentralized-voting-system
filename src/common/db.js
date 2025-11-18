const path = require("path");

const tryLoadBetterSqlite3 = () => {
    const isElectron = Boolean(process?.versions?.electron);
    const candidates = isElectron
        ? [
              path.resolve(
                  __dirname,
                  "../../apps/presentation/node_modules/better-sqlite3"
              ),
              "better-sqlite3",
          ]
        : ["better-sqlite3"];

    const retriableCodes = new Set(["MODULE_NOT_FOUND", "ERR_DLOPEN_FAILED"]);

    let lastError;

    for (const candidate of candidates) {
        try {
            return require(candidate);
        } catch (error) {
            lastError = error;

            if (!retriableCodes.has(error?.code)) {
                throw error;
            }
        }
    }

    throw lastError;
};

const Database = tryLoadBetterSqlite3();

const { resolved } = require("./config");
const { ensureDir } = require("./utils");

const dbPath = resolved.DB_PATH;
ensureDir(dbPath);

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.exec(`
    CREATE TABLE IF NOT EXISTS elections (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        start_iso TEXT NOT NULL,
        end_iso TEXT NOT NULL,
        choices_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tokens (
        tokenId TEXT PRIMARY KEY,
        electionId TEXT NOT NULL,
        voterId TEXT NOT NULL,
        tokenJwt TEXT NOT NULL,
        used INTEGER DEFAULT 0 NOT NULL,
        issuedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ledger (
        "index" INTEGER PRIMARY KEY AUTOINCREMENT,
        commitment TEXT UNIQUE NOT NULL,
        cipherRef TEXT NOT NULL,
        electionId TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        receiptId TEXT NOT NULL
    )
`);

const insertElectionStmt = db.prepare(`
    INSERT INTO elections (id, title, start_iso, end_iso, choices_json)
    VALUES (@id, @title, @start_iso, @end_iso, @choices_json)
`);

const selectElectionStmt = db.prepare(`
    SELECT id, title, start_iso, end_iso, choices_json
    FROM elections
    WHERE id = @id
`);

const listElectionsStmt = db.prepare(`
    SELECT id, title, start_iso, end_iso, choices_json
    FROM elections
    ORDER BY start_iso, id
`);

const deleteElectionStmt = db.prepare(`
    DELETE FROM elections WHERE id = @id
`);

const insertTokenStmt = db.prepare(`
    INSERT INTO tokens (tokenId, electionId, voterId, tokenJwt, used, issuedAt)
    VALUES (@tokenId, @electionId, @voterId, @tokenJwt, @used, @issuedAt)
`);

const getTokenStmt = db.prepare(`
    SELECT tokenId, electionId, voterId, tokenJwt, used, issuedAt
    FROM tokens
    WHERE tokenId = @tokenId
`);

const listTokensStmt = db.prepare(`
    SELECT tokenId, electionId, voterId, tokenJwt, used, issuedAt
    FROM tokens
    ORDER BY issuedAt DESC
`);

const markTokenUsedStmt = db.prepare(`
    UPDATE tokens SET used = 1
    WHERE tokenId = @tokenId AND used = 0
`);

const insertLedgerStmt = db.prepare(`
    INSERT INTO ledger (commitment, cipherRef, electionId, timestamp, receiptId)
    VALUES (@commitment, @cipherRef, @electionId, @timestamp, @receiptId)
`);

const selectLedgerByIndexStmt = db.prepare(`
    SELECT "index" as ledgerIndex, commitment, cipherRef, electionId, timestamp, receiptId
    FROM ledger
    WHERE "index" = @index
`);

const selectLedgerByReceiptStmt = db.prepare(`
    SELECT "index" as ledgerIndex, commitment, cipherRef, electionId, timestamp, receiptId
    FROM ledger
    WHERE receiptId = @receiptId
`);

const normalizeChoices = (choices) => {
    if (!Array.isArray(choices)) {
        throw new TypeError("choices must be an array");
    }

    return choices;
};

const insertElection = ({ id, title, startIso, endIso, choices }) => {
    const payload = {
        id,
        title,
        start_iso: startIso,
        end_iso: endIso,
        choices_json: JSON.stringify(normalizeChoices(choices)),
    };

    return insertElectionStmt.run(payload);
};

const getElection = (id) => {
    const row = selectElectionStmt.get({ id });
    if (!row) {
        return undefined;
    }

    return {
        ...row,
        choices: JSON.parse(row.choices_json),
    };
};

const listElections = () =>
    listElectionsStmt.all().map((row) => ({
        ...row,
        choices: JSON.parse(row.choices_json),
    }));

const deleteElection = (id) => deleteElectionStmt.run({ id });

const insertToken = ({
    tokenId,
    electionId,
    voterId,
    tokenJwt,
    used = 0,
    issuedAt,
}) =>
    insertTokenStmt.run({
        tokenId,
        electionId,
        voterId,
        tokenJwt,
        used,
        issuedAt,
    });

const getToken = (tokenId) => getTokenStmt.get({ tokenId });

const listTokens = () => listTokensStmt.all();

const markTokenUsed = (tokenId) => markTokenUsedStmt.run({ tokenId });

const insertLedgerEntry = ({
    commitment,
    cipherRef,
    electionId,
    timestamp,
    receiptId,
}) =>
    insertLedgerStmt.run({
        commitment,
        cipherRef,
        electionId,
        timestamp,
        receiptId,
    });

const getLedgerByIndex = (index) => selectLedgerByIndexStmt.get({ index });

const getLedgerByReceiptId = (receiptId) =>
    selectLedgerByReceiptStmt.get({ receiptId });

module.exports = {
    getDb: () => db,
    insertElection,
    getElection,
    listElections,
    deleteElection,
    insertToken,
    getToken,
    listTokens,
    markTokenUsed,
    insertLedgerEntry,
    getLedgerByIndex,
    getLedgerByReceiptId,
    dbPath,
};
