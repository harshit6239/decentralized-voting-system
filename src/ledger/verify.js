const fs = require("fs");
const path = require("path");

const { getToken, getLedgerByReceiptId } = require("../common/db");
const { verifyReceiptSignature } = require("./signing");

const ledgerLogPath = path.join(
    path.resolve(process.cwd(), "data"),
    "ledger.jsonl"
);

const findLedgerLogEntry = (receiptId) => {
    if (!receiptId || !fs.existsSync(ledgerLogPath)) {
        return null;
    }

    const lines = fs.readFileSync(ledgerLogPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
        if (!line.trim()) {
            continue;
        }

        try {
            const entry = JSON.parse(line);
            if (entry.receipt?.receiptId === receiptId) {
                return entry;
            }
        } catch (error) {
            // ignore malformed lines
        }
    }

    return null;
};

const verifyTokenStatus = (tokenId) => {
    if (!tokenId) {
        return { valid: false };
    }

    const token = getToken(tokenId);
    if (!token) {
        return { valid: false };
    }

    return {
        valid: true,
        used: token.used,
        electionId: token.electionId,
    };
};

const verifyReceiptStatus = (receiptId) => {
    if (!receiptId) {
        return { valid: false };
    }

    const ledgerRow = getLedgerByReceiptId(receiptId);
    if (!ledgerRow) {
        return { valid: false };
    }

    const logEntry = findLedgerLogEntry(receiptId);
    if (!logEntry || !logEntry.receipt || !logEntry.signature) {
        return { valid: false };
    }

    const valid = verifyReceiptSignature(logEntry.receipt, logEntry.signature);

    return {
        valid,
        ledgerIndex:
            logEntry.receipt.ledgerIndex ?? ledgerRow.ledgerIndex ?? null,
        commitment: logEntry.receipt.commitment ?? ledgerRow.commitment ?? null,
        electionId: logEntry.receipt.electionId ?? ledgerRow.electionId ?? null,
    };
};

module.exports = {
    verifyTokenStatus,
    verifyReceiptStatus,
};
