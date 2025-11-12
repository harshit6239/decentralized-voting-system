const fs = require("fs");
const path = require("path");
const express = require("express");
const jwt = require("jsonwebtoken");
const pino = require("pino");
const { v4: uuidv4 } = require("uuid");

const { PORT_LEDGER } = require("../common/config");
const { ensureDir, nowISO } = require("../common/utils");
const {
    getDb,
    getToken,
    markTokenUsed,
    insertLedgerEntry,
    getLedgerByIndex,
    getLedgerByReceiptId,
} = require("../common/db");
const { computeCommitment } = require("../common/crypto");
const {
    loadPublicKey: loadRaPublicKey,
    SIGNING_ALGORITHM: RA_SIGNING_ALGO,
} = require("../ra/tokenService");
const {
    ensureLedgerKeys,
    signReceipt,
    verifyReceiptSignature,
} = require("./signing");
const { verifyTokenStatus, verifyReceiptStatus } = require("./verify");
const { runTally } = require("./tally");

const logger = pino();
const db = getDb();

const dataDir = path.resolve(process.cwd(), "data");
const cipherDir = path.join(dataDir, "ciphers");
const ledgerLogPath = path.join(dataDir, "ledger.jsonl");

const ensureStorage = () => {
    ensureDir(path.join(cipherDir, "placeholder"));
    ensureDir(ledgerLogPath);
};

ensureStorage();
ensureLedgerKeys();

const getRaPublicKey = () => loadRaPublicKey();

const appendLedgerLog = (entry) => {
    const serialized = `${JSON.stringify(entry)}\n`;
    fs.appendFileSync(ledgerLogPath, serialized, "utf8");
};

const findLedgerLogEntry = (receiptId) => {
    if (!fs.existsSync(ledgerLogPath)) {
        return null;
    }

    const lines = fs.readFileSync(ledgerLogPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
        if (!line) {
            continue;
        }

        try {
            const parsed = JSON.parse(line);
            if (
                parsed.receipt?.receiptId === receiptId ||
                parsed.receiptId === receiptId
            ) {
                return parsed.receipt
                    ? parsed
                    : { ...parsed, receipt: parsed.receipt }; // tolerate old format
            }
        } catch (error) {
            logger.warn({ err: error }, "Failed to parse ledger log line");
        }
    }

    return null;
};

const decodeBase64 = (value, fieldName) => {
    try {
        return Buffer.from(value, "base64");
    } catch (error) {
        throw new Error(`${fieldName} is not valid base64 data`);
    }
};

const validateSubmissionBody = (body) => {
    const required = [
        "tokenJwt",
        "ciphertextB64",
        "nonceB64",
        "commitmentHex",
        "electionId",
        "timestamp",
    ];

    for (const field of required) {
        if (
            !body ||
            typeof body[field] !== "string" ||
            body[field].length === 0
        ) {
            throw new Error(`Missing or invalid field '${field}'`);
        }
    }
};

const createApp = () => {
    const app = express();
    app.use(express.json({ limit: "1mb" }));

    app.post("/submit", (req, res) => {
        try {
            validateSubmissionBody(req.body);
        } catch (error) {
            res.status(400).json({ message: error.message });
            return;
        }

        const {
            tokenJwt,
            ciphertextB64,
            nonceB64,
            commitmentHex,
            electionId,
            timestamp,
        } = req.body;

        let decodedToken;
        try {
            const raPublicKeyPem = getRaPublicKey();
            decodedToken = jwt.verify(tokenJwt, raPublicKeyPem, {
                algorithms: [RA_SIGNING_ALGO],
            });
        } catch (error) {
            logger.warn({ err: error }, "Token verification failed");
            res.status(401).json({ message: "Invalid or expired token" });
            return;
        }

        const { tokenId, electionId: tokenElectionId } = decodedToken;

        if (!tokenId) {
            res.status(400).json({ message: "Token missing tokenId claim" });
            return;
        }

        if (tokenElectionId !== electionId) {
            res.status(400).json({ message: "Token election mismatch" });
            return;
        }

        const recomputedCommitment = computeCommitment(ciphertextB64, nonceB64);
        if (recomputedCommitment !== commitmentHex) {
            res.status(400).json({
                message: "Commitment does not match ciphertext",
            });
            return;
        }

        let ciphertextBuffer;
        try {
            ciphertextBuffer = decodeBase64(ciphertextB64, "ciphertextB64");
        } catch (error) {
            res.status(400).json({ message: error.message });
            return;
        }

        try {
            decodeBase64(nonceB64, "nonceB64");
        } catch (error) {
            res.status(400).json({ message: error.message });
            return;
        }

        const cipherFilename = `${commitmentHex}.bin`;
        const cipherFilePath = path.join(cipherDir, cipherFilename);

        const tokenRow = getToken(tokenId);
        if (!tokenRow) {
            res.status(400).json({ message: "Token not recognized" });
            return;
        }

        if (tokenRow.used) {
            res.status(409).json({ message: "Token already used" });
            return;
        }

        if (tokenRow.electionId !== electionId) {
            res.status(400).json({ message: "Token record election mismatch" });
            return;
        }

        const receiptId = uuidv4();
        const ledgerRecord = {
            commitment: commitmentHex,
            cipherRef: path.relative(process.cwd(), cipherFilePath),
            electionId,
            timestamp,
            receiptId,
        };

        const submissionTx = db.transaction(() => {
            const updateInfo = markTokenUsed(tokenId);
            if (updateInfo.changes !== 1) {
                throw new Error("Token already used");
            }

            const insertInfo = insertLedgerEntry(ledgerRecord);
            return insertInfo.lastInsertRowid;
        });

        let ledgerIndex;
        try {
            ledgerIndex = submissionTx();
        } catch (error) {
            logger.warn({ err: error }, "Ledger transaction failed");
            res.status(409).json({ message: error.message });
            return;
        }

        ensureDir(cipherFilePath);
        fs.writeFileSync(cipherFilePath, ciphertextBuffer);

        ensureDir(ledgerLogPath);

        const receipt = {
            receiptId,
            ledgerIndex,
            commitment: commitmentHex,
            timestamp,
            electionId,
        };

        const signature = signReceipt(receipt);

        appendLedgerLog({
            ...ledgerRecord,
            ledgerIndex,
            nonceB64,
            receipt,
            signature,
            storedAt: nowISO(),
        });

        res.json({
            ...receipt,
            signature,
        });
    });

    app.get("/ledger/:index", (req, res) => {
        const ledgerIndex = Number.parseInt(req.params.index, 10);
        if (Number.isNaN(ledgerIndex)) {
            res.status(400).json({ message: "Invalid ledger index" });
            return;
        }

        const row = getLedgerByIndex(ledgerIndex);
        if (!row) {
            res.status(404).json({ message: "Ledger entry not found" });
            return;
        }

        res.json(row);
    });

    app.get("/verify/:receiptId", (req, res) => {
        const { receiptId } = req.params;
        const row = getLedgerByReceiptId(receiptId);
        if (!row) {
            res.status(404).json({ message: "Receipt not found" });
            return;
        }

        const logEntry = findLedgerLogEntry(receiptId);
        if (!logEntry || !logEntry.signature || !logEntry.receipt) {
            res.status(500).json({
                message: "Receipt signature record missing",
            });
            return;
        }

        const valid = verifyReceiptSignature(
            logEntry.receipt,
            logEntry.signature
        );
        res.json({
            receipt: logEntry.receipt,
            signature: logEntry.signature,
            ledgerIndex: row.ledgerIndex,
            valid,
        });
    });

    app.post("/tally", async (req, res) => {
        const adminToken = process.env.ADMIN_TOKEN;
        if (adminToken) {
            const provided = req.get("X-ADMIN-TOKEN");
            if (provided !== adminToken) {
                res.status(401).json({ message: "Unauthorized" });
                return;
            }
        }

        const { electionId } = req.body || {};
        if (!electionId) {
            res.status(400).json({ message: "electionId is required" });
            return;
        }

        try {
            const result = await runTally(electionId);
            res.json(result);
        } catch (error) {
            if (error.message === "Election not ended") {
                res.status(409).json({ message: error.message });
                return;
            }

            if (/not found/i.test(error.message)) {
                res.status(404).json({ message: error.message });
                return;
            }

            logger.error({ err: error, electionId }, "Tally generation failed");
            res.status(500).json({ message: "Failed to generate tally" });
        }
    });

    app.get("/verify-token/:tokenId", (req, res) => {
        const { tokenId } = req.params;
        const result = verifyTokenStatus(tokenId);
        res.json(result);
    });

    app.get("/verify-receipt/:receiptId", (req, res) => {
        const { receiptId } = req.params;
        const result = verifyReceiptStatus(receiptId);
        res.json(result);
    });

    return app;
};

if (require.main === module) {
    const app = createApp();
    const port = Number(PORT_LEDGER) || 4000;
    app.listen(port, () => {
        logger.info({ port }, "Ledger service listening");
    });
}

module.exports = {
    createApp,
};
