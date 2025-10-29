jest.setTimeout(10000);

const fs = require("fs");
const path = require("path");
const os = require("os");

const { runTally } = require("../tally");
const {
    genKeypair,
    encryptWithPublicKey,
    computeCommitment,
    constants,
} = require("../../common/crypto");
const { nowISO, ensureDir } = require("../../common/utils");
const {
    insertElection,
    deleteElection,
    insertLedgerEntry,
    getDb,
} = require("../../common/db");

const db = getDb();
const dataDir = path.resolve(process.cwd(), "data");
const ledgerLogPath = path.join(dataDir, "ledger.jsonl");
let cipherDir = path.join(dataDir, "ciphers");

const removePath = (targetPath) => {
    fs.rmSync(targetPath, { recursive: true, force: true });
};

const appendLedgerLog = (record) => {
    ensureDir(ledgerLogPath);
    fs.appendFileSync(ledgerLogPath, `${JSON.stringify(record)}\n`, "utf8");
};

describe("ledger tally", () => {
    const electionId = "tally-e1";

    beforeEach(() => {
        removePath(cipherDir);
        cipherDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "btp-tally-ciphers-")
        );

        removePath(ledgerLogPath);

        db.prepare('DELETE FROM "ledger"').run();
        deleteElection(electionId);

        if (fs.existsSync(dataDir)) {
            fs.readdirSync(dataDir)
                .filter((file) => file.startsWith(`tally-${electionId}-`))
                .forEach((file) => {
                    fs.rmSync(path.join(dataDir, file), { force: true });
                });
        }
    });

    test("runTally aggregates decrypted ballots", async () => {
        const endIso = new Date(Date.now() - 60_000).toISOString();
        insertElection({
            id: electionId,
            title: "Tally Election",
            startIso: new Date(Date.now() - 120_000).toISOString(),
            endIso,
            choices: ["A", "B"],
        });

        const electionKeys = genKeypair(`election-${electionId}`);
        const electionPrivateKeyPath = electionKeys[constants.KEY_ALGO_BOX];

        const choices = ["A", "B", "A"];
        choices.forEach((choice, idx) => {
            const ballot = {
                electionId,
                voterId: `v${idx + 1}`,
                choice,
                timestamp: nowISO(),
            };

            const { ciphertextBase64, nonceBase64 } = encryptWithPublicKey(
                JSON.stringify(ballot),
                electionPrivateKeyPath
            );

            const commitment = computeCommitment(ciphertextBase64, nonceBase64);

            ensureDir(path.join(cipherDir, `${commitment}.bin`));
            const cipherFile = path.join(cipherDir, `${commitment}.bin`);
            fs.writeFileSync(
                cipherFile,
                Buffer.from(ciphertextBase64, "base64")
            );

            expect(fs.existsSync(cipherFile)).toBe(true);

            const insertResult = insertLedgerEntry({
                commitment,
                cipherRef: cipherFile,
                electionId,
                timestamp: ballot.timestamp,
                receiptId: `receipt-${idx + 1}`,
            });

            appendLedgerLog({
                ledgerIndex: Number(insertResult.lastInsertRowid),
                commitment,
                nonceB64: nonceBase64,
                receipt: {
                    receiptId: `receipt-${idx + 1}`,
                    commitment,
                },
                signature: "sig",
                storedAt: nowISO(),
            });
        });

        const result = await runTally(electionId, {
            privateKeyPath: electionPrivateKeyPath,
        });

        expect(result.totalVotes).toBe(3);
        expect(result.results).toEqual([
            { choiceId: "A", count: 2 },
            { choiceId: "B", count: 1 },
        ]);
        expect(typeof result.signature).toBe("string");
        expect(result.signature.length).toBeGreaterThan(0);

        const tallyFiles = fs
            .readdirSync(dataDir)
            .filter((file) => file.startsWith(`tally-${electionId}-`));
        expect(tallyFiles.length).toBeGreaterThan(0);
    });

    afterEach(() => {
        removePath(cipherDir);
    });
});
