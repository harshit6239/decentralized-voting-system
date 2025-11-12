jest.setTimeout(10000);

const fs = require("fs");
const path = require("path");
const os = require("os");

const originalCwd = process.cwd();
const originalDbPath = process.env.DB_PATH;
const originalKeysDir = process.env.KEYS_DIR;
const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "audit-suite-"));

process.chdir(sandboxRoot);
process.env.DB_PATH = path.join(sandboxRoot, "data", "ledger.db");
process.env.KEYS_DIR = path.join(sandboxRoot, "keys");

const { auditElection } = require("../audit");
const {
    genKeypair,
    encryptWithPublicKey,
    computeCommitment,
    constants,
} = require("../../common/crypto");
const { nowISO, ensureDir } = require("../../common/utils");
const { insertLedgerEntry, deleteElection, getDb } = require("../../common/db");

const dataDir = path.resolve(process.cwd(), "data");
const cipherDir = path.join(dataDir, "ciphers");
const ledgerLogPath = path.join(dataDir, "ledger.jsonl");
const vvpatDir = path.resolve(process.cwd(), "src", "terminal_vvpats");

const db = getDb();

const appendLedgerLog = (record) => {
    ensureDir(ledgerLogPath);
    fs.appendFileSync(ledgerLogPath, `${JSON.stringify(record)}\n`, "utf8");
};

const removeVvpatFiles = (electionId) => {
    if (!fs.existsSync(vvpatDir)) {
        return;
    }

    fs.readdirSync(vvpatDir)
        .filter((file) => file.endsWith(".json"))
        .forEach((file) => {
            const filePath = path.join(vvpatDir, file);
            try {
                const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
                if (content?.ballotPlain?.electionId === electionId) {
                    fs.rmSync(filePath, { force: true });
                }
            } catch (error) {
                // ignore unrelated malformed fixtures
            }
        });
};

const removeAuditReports = (electionId) => {
    if (!fs.existsSync(dataDir)) {
        return;
    }

    fs.readdirSync(dataDir)
        .filter((file) => file.startsWith(`audit-report-${electionId}-`))
        .forEach((file) => {
            fs.rmSync(path.join(dataDir, file), { force: true });
        });
};

const cleanupElectionArtifacts = (electionId) => {
    db.prepare("DELETE FROM ledger WHERE electionId = ?").run(electionId);
    deleteElection(electionId);
    removeVvpatFiles(electionId);
    removeAuditReports(electionId);
};

const createdCipherFiles = new Set();
const createdVvpatFiles = new Set();

const removeLedgerLogEntries = (electionIds) => {
    if (!fs.existsSync(ledgerLogPath)) {
        return;
    }

    const lines = fs.readFileSync(ledgerLogPath, "utf8").split(/\r?\n/);
    const filtered = [];
    let changed = false;

    for (const line of lines) {
        if (!line.trim()) {
            continue;
        }

        try {
            const entry = JSON.parse(line);
            const entryElectionId =
                entry.electionId || entry.receipt?.electionId || null;

            if (entryElectionId && electionIds.includes(entryElectionId)) {
                changed = true;
                continue;
            }
        } catch (error) {
            // keep malformed lines untouched
        }

        filtered.push(line);
    }

    if (!changed) {
        return;
    }

    const serialized = filtered.length ? `${filtered.join("\n")}\n` : "";
    fs.writeFileSync(ledgerLogPath, serialized, "utf8");
};

const seedBallot = ({
    electionId,
    voterId,
    choice,
    receiptId,
    electionPrivateKeyPath,
    vvpatBallotOverride,
}) => {
    const ballot = {
        electionId,
        voterId,
        choice,
        timestamp: nowISO(),
    };

    const { voterId: _omitForCipher, ...anonymousBallot } = ballot;

    const { ciphertextBase64, nonceBase64 } = encryptWithPublicKey(
        JSON.stringify(anonymousBallot),
        electionPrivateKeyPath
    );

    const commitment = computeCommitment(ciphertextBase64, nonceBase64);
    const cipherFile = path.join(cipherDir, `${commitment}.bin`);
    ensureDir(cipherFile);
    fs.writeFileSync(cipherFile, Buffer.from(ciphertextBase64, "base64"));
    createdCipherFiles.add(cipherFile);

    const insertResult = insertLedgerEntry({
        commitment,
        cipherRef: path.relative(process.cwd(), cipherFile),
        electionId,
        timestamp: ballot.timestamp,
        receiptId,
    });

    appendLedgerLog({
        ledgerIndex: Number(insertResult.lastInsertRowid),
        commitment,
        nonceB64: nonceBase64,
        receipt: {
            receiptId,
            commitment,
        },
        storedAt: nowISO(),
    });

    const defaultVvpatBallot = { ...anonymousBallot };
    const vvpatBallot =
        typeof vvpatBallotOverride === "function"
            ? vvpatBallotOverride({ ...defaultVvpatBallot })
            : defaultVvpatBallot;

    const vvpatPayload = {
        ballotPlain: vvpatBallot,
        receipt: {
            receiptId,
            ledgerIndex: Number(insertResult.lastInsertRowid),
            commitment,
            timestamp: nowISO(),
            signature: "sig",
        },
        timestamp: nowISO(),
    };

    const vvpatPath = path.join(vvpatDir, `${commitment}.json`);
    ensureDir(vvpatPath);
    fs.writeFileSync(
        vvpatPath,
        `${JSON.stringify(vvpatPayload, null, 2)}\n`,
        "utf8"
    );
    createdVvpatFiles.add(vvpatPath);

    return { commitment, vvpatPath };
};

describe("auditElection", () => {
    const electionIds = ["audit-pass", "audit-fail"];

    beforeEach(() => {
        electionIds.forEach((id) => cleanupElectionArtifacts(id));
        createdCipherFiles.clear();
        createdVvpatFiles.clear();
        removeLedgerLogEntries(electionIds);
    });

    afterEach(() => {
        createdCipherFiles.forEach((file) => {
            fs.rmSync(file, { force: true });
        });
        createdVvpatFiles.forEach((file) => {
            fs.rmSync(file, { force: true });
        });
        electionIds.forEach((id) => cleanupElectionArtifacts(id));
        removeLedgerLogEntries(electionIds);
    });

    afterAll(() => {
        if (db && typeof db.close === "function") {
            db.close();
        }

        process.chdir(originalCwd);

        if (originalDbPath !== undefined) {
            process.env.DB_PATH = originalDbPath;
        } else {
            delete process.env.DB_PATH;
        }

        if (originalKeysDir !== undefined) {
            process.env.KEYS_DIR = originalKeysDir;
        } else {
            delete process.env.KEYS_DIR;
        }

        fs.rmSync(sandboxRoot, { recursive: true, force: true });
    });

    test("returns PASS when VVPAT records match decrypted ballots", async () => {
        const electionId = "audit-pass";
        const keys = genKeypair(`audit-${Date.now()}`);
        const electionPrivateKeyPath = keys[constants.KEY_ALGO_BOX];

        const ballots = [
            { voterId: "v1", choice: "A", receiptId: "rec-1" },
            { voterId: "v2", choice: "B", receiptId: "rec-2" },
            { voterId: "v3", choice: "C", receiptId: "rec-3" },
        ];

        ballots.forEach((entry) =>
            seedBallot({
                electionId,
                voterId: entry.voterId,
                choice: entry.choice,
                receiptId: entry.receiptId,
                electionPrivateKeyPath,
            })
        );

        const report = await auditElection(electionId, {
            electionPrivKeyPath: electionPrivateKeyPath,
            sampleRate: 1,
            minSample: 1,
        });

        expect(report.status).toBe("PASS");
        expect(report.passRatio).toBe(1);
        expect(report.samples.length).toBe(ballots.length);
        report.samples.forEach((sample) => {
            expect(sample.status).toBe("PASS");
            expect(sample.details).toBeUndefined();
        });

        const writtenReports = fs
            .readdirSync(dataDir)
            .filter((file) => file.startsWith(`audit-report-${electionId}-`));
        expect(writtenReports.length).toBe(1);
        const persisted = JSON.parse(
            fs.readFileSync(path.join(dataDir, writtenReports[0]), "utf8")
        );
        expect(persisted.status).toBe("PASS");
        expect(persisted.passCount).toBe(report.passCount);
    });

    test("flags mismatched ballots in the audit sample", async () => {
        const electionId = "audit-fail";
        const keys = genKeypair(`audit-fail-${Date.now()}`);
        const electionPrivateKeyPath = keys[constants.KEY_ALGO_BOX];

        seedBallot({
            electionId,
            voterId: "v1",
            choice: "A",
            receiptId: "rec-1",
            electionPrivateKeyPath,
        });

        seedBallot({
            electionId,
            voterId: "v2",
            choice: "B",
            receiptId: "rec-2",
            electionPrivateKeyPath,
            vvpatBallotOverride: (ballot) => ({
                ...ballot,
                choice: "C",
            }),
        });

        const report = await auditElection(electionId, {
            electionPrivKeyPath: electionPrivateKeyPath,
            sampleRate: 1,
            minSample: 2,
        });

        expect(report.status).toBe("FAIL");
        expect(report.samples.length).toBe(2);

        const failSample = report.samples.find(
            (sample) => sample.status === "FAIL"
        );
        expect(failSample).toBeDefined();
        expect(failSample.details).toBe("Ballot mismatch");
        expect(report.passRatio).toBeLessThan(0.98);
    });
});
