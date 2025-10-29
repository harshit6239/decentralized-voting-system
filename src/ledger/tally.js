const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const { resolved } = require("../common/config");
const { ensureDir, nowISO } = require("../common/utils");
const {
    decryptWithPrivateKey,
    signMessage,
    genKeypair,
    constants,
} = require("../common/crypto");
const { getDb, dbPath: defaultDbPath } = require("../common/db");

const DATA_DIR = path.resolve(process.cwd(), "data");
const CIPHER_DIR = path.join(DATA_DIR, "ciphers");
const LEDGER_LOG_PATH = path.join(DATA_DIR, "ledger.jsonl");
const TALLY_FILE_PREFIX = "tally";
const LEDGER_SIGN_LABEL = "ledger-sign";

const getLedgerSigningKeyPath = () => {
    const expectedPath = path.join(
        resolved.KEYS_DIR,
        `${LEDGER_SIGN_LABEL}-${constants.KEY_ALGO_SIGN}.json`
    );

    if (!fs.existsSync(expectedPath)) {
        genKeypair(LEDGER_SIGN_LABEL);
    }

    if (!fs.existsSync(expectedPath)) {
        throw new Error("Ledger signing key not found");
    }

    return expectedPath;
};

const getDatabase = (dbPathOverride) => {
    if (!dbPathOverride || dbPathOverride === defaultDbPath) {
        return { db: getDb(), dispose: () => {} };
    }

    ensureDir(dbPathOverride);
    const db = new Database(dbPathOverride);
    return {
        db,
        dispose: () => db.close(),
    };
};

const loadLedgerMetadata = () => {
    const map = new Map();

    if (!fs.existsSync(LEDGER_LOG_PATH)) {
        return map;
    }

    const raw = fs.readFileSync(LEDGER_LOG_PATH, "utf8");
    const lines = raw.split(/\r?\n/);

    for (const line of lines) {
        if (!line.trim()) {
            continue;
        }

        try {
            const entry = JSON.parse(line);
            const commitment = entry.commitment || entry.receipt?.commitment;
            if (!commitment) {
                continue;
            }

            const nonceB64 = entry.nonceB64 || entry.nonceBase64;
            if (!nonceB64) {
                continue;
            }

            map.set(commitment, nonceB64);
        } catch (error) {
            // Skip malformed lines but continue processing others.
        }
    }

    return map;
};

const resolveCipherPath = (cipherRef) => {
    if (!cipherRef) {
        throw new Error("Missing cipher reference");
    }

    return path.isAbsolute(cipherRef)
        ? cipherRef
        : path.resolve(process.cwd(), cipherRef);
};

const determineElectionKeyPath = (electionId, overridePath) => {
    if (overridePath) {
        return overridePath;
    }

    const candidate = path.join(
        resolved.KEYS_DIR,
        `${electionId}-${constants.KEY_ALGO_BOX}.json`
    );

    if (!fs.existsSync(candidate)) {
        throw new Error(`Election private key not found at ${candidate}`);
    }

    return candidate;
};

const buildSafeFilename = (electionId, timestamp) => {
    const safeTime = timestamp.replace(/[:.]/g, "-");
    return `${TALLY_FILE_PREFIX}-${electionId}-${safeTime}.json`;
};

const orderResults = (countsMap) =>
    Array.from(countsMap.entries())
        .map(([choiceId, count]) => ({ choiceId, count }))
        .sort((a, b) => a.choiceId.localeCompare(b.choiceId));

/**
 * Execute a tally for the provided election identifier.
 * @param {string} electionId
 * @param {{ privateKeyPath?: string, dbPath?: string }} [options]
 * @returns {Promise<Record<string, any>>}
 */
const runTally = async (electionId, options = {}) => {
    if (!electionId) {
        throw new Error("electionId is required for tally");
    }

    const { privateKeyPath: privateKeyOverride, dbPath } = options;
    const { db, dispose } = getDatabase(dbPath);

    try {
        const election = db
            .prepare("SELECT id, end_iso FROM elections WHERE id = ?")
            .get(electionId);

        if (!election) {
            throw new Error(`Election '${electionId}' not found`);
        }

        const endTime = new Date(election.end_iso);
        if (Number.isNaN(endTime.getTime())) {
            throw new Error(`Election '${electionId}' has invalid end time`);
        }

        if (Date.now() < endTime.getTime()) {
            throw new Error("Election not ended");
        }

        const ledgerRows = db
            .prepare(
                'SELECT "index" as ledgerIndex, commitment, cipherRef, timestamp FROM ledger WHERE electionId = ? ORDER BY "index" ASC'
            )
            .all(electionId);

        const nonceMap = loadLedgerMetadata();
        const electionKeyPath = determineElectionKeyPath(
            electionId,
            privateKeyOverride
        );

        const counts = new Map();

        for (const row of ledgerRows) {
            const nonceB64 = nonceMap.get(row.commitment);
            if (!nonceB64) {
                throw new Error(
                    `Missing nonce for commitment ${row.commitment}`
                );
            }

            const cipherPath = resolveCipherPath(row.cipherRef);
            if (!fs.existsSync(cipherPath)) {
                throw new Error(
                    `Cipher file missing for commitment ${row.commitment}`
                );
            }

            const ciphertextBase64 = fs
                .readFileSync(cipherPath)
                .toString("base64");

            const plaintext = decryptWithPrivateKey(
                ciphertextBase64,
                nonceB64,
                electionKeyPath
            );

            let ballot;
            try {
                ballot = JSON.parse(plaintext);
            } catch (error) {
                throw new Error(
                    `Invalid ballot payload for commitment ${row.commitment}`
                );
            }

            const choiceId =
                ballot.choiceId || ballot.choice || ballot.selection;
            if (!choiceId) {
                throw new Error(
                    `Ballot missing choice identifier for commitment ${row.commitment}`
                );
            }

            counts.set(choiceId, (counts.get(choiceId) || 0) + 1);
        }

        const tallyTime = nowISO();
        const results = orderResults(counts);
        const totalVotes = results.reduce((acc, item) => acc + item.count, 0);

        const baseResult = {
            electionId,
            results,
            totalVotes,
            tallyTime,
            proofAggregate: "PROOF_PLACEHOLDER",
        };

        const ledgerSigningKeyPath = getLedgerSigningKeyPath();
        const signature = signMessage(
            ledgerSigningKeyPath,
            JSON.stringify(baseResult)
        );

        const finalResult = {
            ...baseResult,
            signature,
        };

        const fileName = buildSafeFilename(electionId, tallyTime);
        const tallyPath = path.join(DATA_DIR, fileName);
        ensureDir(tallyPath);
        fs.writeFileSync(
            tallyPath,
            `${JSON.stringify(finalResult, null, 2)}\n`,
            "utf8"
        );

        return finalResult;
    } finally {
        dispose();
    }
};

module.exports = {
    runTally,
};
