const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { decryptWithPrivateKey } = require("../common/crypto");
const { ensureDir, nowISO } = require("../common/utils");
const { getDb } = require("../common/db");

const DATA_DIR = path.resolve(process.cwd(), "data");
const VVPAT_DIR = path.resolve(process.cwd(), "src", "terminal_vvpats");
const CIPHER_DIR = path.resolve(process.cwd(), "data", "ciphers");

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));

const seededRandomGenerator = (seedBuffer) => {
    let state = BigInt(`0x${seedBuffer.toString("hex")}`);
    const modulus = BigInt(2) ** BigInt(64);
    const multiplier = BigInt(6364136223846793005);
    const increment = BigInt(1442695040888963407);

    return () => {
        state = (state * multiplier + increment) % modulus;
        return Number(state % BigInt(1_000_000)) / 1_000_000;
    };
};

const sampleDeterministically = (items, sampleSize, rng) => {
    if (items.length <= sampleSize) {
        return items;
    }

    const indices = new Set();
    while (indices.size < sampleSize) {
        const idx = Math.floor(rng() * items.length);
        indices.add(idx);
    }

    return Array.from(indices)
        .sort((a, b) => a - b)
        .map((idx) => items[idx]);
};

const loadVvpatsForElection = (electionId) => {
    if (!fs.existsSync(VVPAT_DIR)) {
        return [];
    }

    return fs
        .readdirSync(VVPAT_DIR)
        .filter((file) => file.endsWith(".json"))
        .map((file) => path.join(VVPAT_DIR, file))
        .map((file) => ({ filePath: file, content: readJson(file) }))
        .filter(
            (entry) => entry.content.ballotPlain?.electionId === electionId
        );
};

const loadLedgerEntries = (db, electionId) =>
    db
        .prepare(
            'SELECT "index" as ledgerIndex, commitment, cipherRef, electionId, timestamp FROM ledger WHERE electionId = ? ORDER BY "index" ASC'
        )
        .all(electionId);

const loadLedgerLogMap = () => {
    const logPath = path.join(DATA_DIR, "ledger.jsonl");
    const map = new Map();

    if (!fs.existsSync(logPath)) {
        return map;
    }

    const lines = fs.readFileSync(logPath, "utf8").split(/\r?\n/);
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

            map.set(commitment, {
                nonceB64: entry.nonceB64 || entry.nonceBase64,
            });
        } catch (error) {
            // ignore malformed lines
        }
    }

    return map;
};

const buildLedgerMap = (rows, logMap) => {
    const map = new Map();
    rows.forEach((row) => {
        map.set(row.commitment, {
            ...row,
            nonceB64: logMap.get(row.commitment)?.nonceB64,
        });
    });
    return map;
};

const resolveCipherPath = (cipherRef) =>
    path.isAbsolute(cipherRef)
        ? cipherRef
        : path.resolve(process.cwd(), cipherRef);

const computeSeed = (ledgerRows) => {
    if (!ledgerRows.length) {
        return crypto.createHash("sha256").update("0").digest();
    }

    const lastCommitment = ledgerRows[ledgerRows.length - 1].commitment;
    return crypto.createHash("sha256").update(lastCommitment).digest();
};

const compareBallots = (voterBallot, decryptedBallot) =>
    JSON.stringify(voterBallot) === JSON.stringify(decryptedBallot);

const auditElection = async (electionId, options = {}) => {
    if (!electionId) {
        throw new Error("electionId is required");
    }

    const { sampleRate = 0.1, minSample = 5, electionPrivKeyPath } = options;

    if (!electionPrivKeyPath) {
        throw new Error("electionPrivKeyPath is required for audit");
    }

    const vvpats = loadVvpatsForElection(electionId);
    const totalVvpats = vvpats.length;
    const timestamp = nowISO();

    if (totalVvpats === 0) {
        throw new Error(`No VVPAT records found for election '${electionId}'`);
    }

    const db = getDb();
    const ledgerRows = loadLedgerEntries(db, electionId);
    const ledgerLogMap = loadLedgerLogMap();
    const ledgerMap = buildLedgerMap(ledgerRows, ledgerLogMap);

    const seed = computeSeed(ledgerRows);
    const rng = seededRandomGenerator(seed);

    const sampleSize = Math.max(minSample, Math.ceil(sampleRate * totalVvpats));

    const sampled = sampleDeterministically(vvpats, sampleSize, rng);

    const samples = sampled.map(({ filePath, content }) => {
        const { commitment } = content.receipt || {};
        const ledgerEntry = commitment ? ledgerMap.get(commitment) : null;
        const result = {
            commitment,
            vvpat: filePath,
            status: "MISSING",
            details: "Ledger entry not found",
        };

        if (!ledgerEntry) {
            return result;
        }

        if (!ledgerEntry.nonceB64) {
            return {
                ...result,
                details: "Nonce not recorded",
            };
        }

        const cipherPath = resolveCipherPath(ledgerEntry.cipherRef);
        if (!fs.existsSync(cipherPath)) {
            return {
                ...result,
                status: "MISSING",
                details: "Cipher file missing",
            };
        }

        const ciphertextBase64 = fs.readFileSync(cipherPath).toString("base64");

        let decrypted;
        try {
            decrypted = JSON.parse(
                decryptWithPrivateKey(
                    ciphertextBase64,
                    ledgerEntry.nonceB64,
                    electionPrivKeyPath
                )
            );
        } catch (error) {
            return {
                ...result,
                status: "FAIL",
                details: `Decryption error: ${error.message}`,
            };
        }

        const matches = compareBallots(content.ballotPlain, decrypted);
        return {
            commitment,
            vvpat: filePath,
            status: matches ? "PASS" : "FAIL",
            details: matches ? undefined : "Ballot mismatch",
        };
    });

    const passCount = samples.filter(
        (sample) => sample.status === "PASS"
    ).length;
    const passRatio = passCount / samples.length;

    const report = {
        electionId,
        totalVvpats,
        sampleRate,
        sampleSize: samples.length,
        passCount,
        passRatio,
        threshold: 0.98,
        status: passRatio >= 0.98 ? "PASS" : "FAIL",
        samples,
        generatedAt: timestamp,
    };

    const reportPath = path.join(
        DATA_DIR,
        `audit-report-${electionId}-${timestamp.replace(/[:.]/g, "-")}.json`
    );
    ensureDir(reportPath);
    fs.writeFileSync(
        reportPath,
        `${JSON.stringify(report, null, 2)}\n`,
        "utf8"
    );

    return report;
};

module.exports = {
    auditElection,
};
