const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const { createApp } = require("../ledger/server");
const { ensureLedgerKeys } = require("../ledger/signing");
const { generateSigningKeys, issueToken } = require("../ra/tokenService");
const {
    insertElection,
    deleteElection,
    getToken,
    getLedgerByIndex,
    getDb,
} = require("../common/db");
const {
    genKeypair,
    encryptWithPublicKey,
    computeCommitment,
} = require("../common/crypto");
const { nowISO } = require("../common/utils");

const db = getDb();
const cipherDir = path.resolve(process.cwd(), "data", "ciphers");
const ledgerLogPath = path.resolve(process.cwd(), "data", "ledger.jsonl");

const resetDataDirs = () => {
    fs.rmSync(cipherDir, { recursive: true, force: true });
    fs.rmSync(ledgerLogPath, { force: true });
};

describe("ledger service", () => {
    const electionId = "ledger-e1";

    beforeAll(() => {
        generateSigningKeys();
        ensureLedgerKeys();
    });

    beforeEach(() => {
        resetDataDirs();
        db.prepare("DELETE FROM tokens").run();
        db.prepare('DELETE FROM "ledger"').run();
        deleteElection(electionId);
        insertElection({
            id: electionId,
            title: "Ledger Test Election",
            startIso: "2025-01-01T00:00:00.000Z",
            endIso: "2025-12-31T23:59:59.000Z",
            choices: ["ChoiceA", "ChoiceB"],
        });
    });

    test("accepts submission and returns receipt", async () => {
        const token = issueToken({ electionId, voterId: "v1" });
        const voterKeys = genKeypair(`ledger-voter-${Date.now()}`);
        const message = JSON.stringify({ selection: "ChoiceA" });
        const { ciphertextBase64, nonceBase64 } = encryptWithPublicKey(
            message,
            voterKeys.x25519
        );
        const commitment = computeCommitment(ciphertextBase64, nonceBase64);
        const timestamp = nowISO();

        const app = createApp();
        const agent = request(app);

        const submitResponse = await agent
            .post("/submit")
            .send({
                tokenJwt: token.tokenJwt,
                ciphertextB64: ciphertextBase64,
                nonceB64: nonceBase64,
                commitmentHex: commitment,
                electionId,
                timestamp,
            })
            .expect(200);

        expect(submitResponse.body.receiptId).toBeDefined();
        expect(submitResponse.body.ledgerIndex).toBeGreaterThan(0);
        expect(submitResponse.body.signature).toBeTruthy();

        const decoded = jwt.decode(token.tokenJwt);
        const tokenRow = getToken(decoded.tokenId);
        expect(tokenRow.used).toBe(1);

        const ledgerIndex = submitResponse.body.ledgerIndex;
        const ledgerRow = getLedgerByIndex(ledgerIndex);
        expect(ledgerRow.commitment).toBe(commitment);
        expect(ledgerRow.electionId).toBe(electionId);

        const cipherPath = path.join(cipherDir, `${commitment}.bin`);
        expect(fs.existsSync(cipherPath)).toBe(true);

        const verifyResponse = await agent
            .get(`/verify/${submitResponse.body.receiptId}`)
            .expect(200);

        expect(verifyResponse.body.valid).toBe(true);
        expect(verifyResponse.body.receipt.commitment).toBe(commitment);

        const ledgerFetch = await agent
            .get(`/ledger/${ledgerIndex}`)
            .expect(200);
        expect(ledgerFetch.body.commitment).toBe(commitment);
    });
});
