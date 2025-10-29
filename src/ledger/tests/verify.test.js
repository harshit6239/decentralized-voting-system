const fs = require("fs");
const path = require("path");
const request = require("supertest");

const { createApp } = require("../server");
const { insertToken, insertLedgerEntry, getDb } = require("../../common/db");
const { nowISO, ensureDir } = require("../../common/utils");
const { signReceipt, ensureLedgerKeys } = require("../signing");

const db = getDb();
const dataDir = path.resolve(process.cwd(), "data");
const ledgerLogPath = path.join(dataDir, "ledger.jsonl");

const appendLedgerLog = (entry) => {
    ensureDir(ledgerLogPath);
    fs.appendFileSync(ledgerLogPath, `${JSON.stringify(entry)}\n`, "utf8");
};

const seedData = () => {
    ensureLedgerKeys();

    const tokenId = "token-test";
    const receiptId = "R-test";
    const electionId = "verify-election";
    const timestamp = nowISO();

    insertToken({
        tokenId,
        electionId,
        voterId: "v1",
        tokenJwt: "placeholder",
        used: 0,
        issuedAt: timestamp,
    });

    const cipherPath = path.join("data", "ciphers", "commit-test.bin");
    ensureDir(cipherPath);

    const insertInfo = insertLedgerEntry({
        commitment: "commit-test",
        cipherRef: cipherPath,
        electionId,
        timestamp,
        receiptId,
    });

    const ledgerIndex = Number(insertInfo.lastInsertRowid);

    const receipt = {
        receiptId,
        ledgerIndex,
        commitment: "commit-test",
        electionId,
        timestamp,
    };

    const signature = signReceipt(receipt);

    appendLedgerLog({
        ledgerIndex,
        commitment: "commit-test",
        receipt,
        signature,
        storedAt: nowISO(),
    });

    return { tokenId, receiptId, ledgerIndex };
};

const cleanup = () => {
    db.prepare("DELETE FROM tokens WHERE tokenId = 'token-test'").run();
    db.prepare("DELETE FROM ledger WHERE receiptId = 'R-test'").run();
    if (fs.existsSync(ledgerLogPath)) {
        const lines = fs
            .readFileSync(ledgerLogPath, "utf8")
            .split(/\r?\n/)
            .filter((line) => line.includes('"receiptId":"R-test"'));
        if (lines.length) {
            const remaining = fs
                .readFileSync(ledgerLogPath, "utf8")
                .split(/\r?\n/)
                .filter((line) => !line.includes('"receiptId":"R-test"'));
            fs.writeFileSync(
                ledgerLogPath,
                `${remaining.filter(Boolean).join("\n")}${
                    remaining.length ? "\n" : ""
                }`,
                "utf8"
            );
        }
    }
};

describe("ledger verify endpoints", () => {
    afterEach(() => {
        cleanup();
    });

    test("verify-token and verify-receipt return expected payloads", async () => {
        const { tokenId, receiptId, ledgerIndex } = seedData();

        const app = createApp();

        const tokenResponse = await request(app)
            .get(`/verify-token/${tokenId}`)
            .expect(200);

        expect(tokenResponse.body).toEqual({
            valid: true,
            used: 0,
            electionId: "verify-election",
        });

        const receiptResponse = await request(app)
            .get(`/verify-receipt/${receiptId}`)
            .expect(200);

        expect(receiptResponse.body.valid).toBe(true);
        expect(receiptResponse.body.ledgerIndex).toBe(ledgerIndex);
        expect(receiptResponse.body.commitment).toBe("commit-test");
        expect(receiptResponse.body.electionId).toBe("verify-election");
    });
});
