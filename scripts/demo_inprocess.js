#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const { cleanDemo, DEFAULT_ELECTION_ID } = require("./cleanup");
const { nowISO, ensureDir } = require("../src/common/utils");
const {
    genKeypair,
    encryptWithPublicKey,
    computeCommitment,
    constants,
} = require("../src/common/crypto");
const {
    generateSigningKeys,
    issueToken,
    raPrivateKeyPath,
    raPublicKeyPath,
} = require("../src/ra/tokenService");
const { ensureLedgerKeys, signReceipt } = require("../src/ledger/signing");
const { runTally } = require("../src/ledger/tally");
const { auditElection } = require("../src/audit/audit");
const {
    getDb,
    insertElection,
    markTokenUsed,
    insertLedgerEntry,
} = require("../src/common/db");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(PROJECT_ROOT, "data");
const CIPHER_DIR = path.join(DATA_DIR, "ciphers");
const TOKENS_DIR = path.join(DATA_DIR, "tokens");
const LEDGER_LOG_PATH = path.join(DATA_DIR, "ledger.jsonl");
const VVPAT_DIR = path.join(PROJECT_ROOT, "src", "terminal_vvpats");

const DEFAULT_DEMO_TITLE = "In-Process Demo Election";
const DEFAULT_DEMO_CHOICES = ["Meridian", "Zephyr", "Solstice"];
const DEFAULT_DEMO_VOTERS = [
    { voterId: "demo-voter-1", choice: DEFAULT_DEMO_CHOICES[0] },
    { voterId: "demo-voter-2", choice: DEFAULT_DEMO_CHOICES[1] },
    { voterId: "demo-voter-3", choice: DEFAULT_DEMO_CHOICES[0] },
];

const relativePath = (absolutePath) =>
    path.relative(PROJECT_ROOT, absolutePath).replace(/\\/g, "/");

const appendLedgerLog = (entry) => {
    ensureDir(LEDGER_LOG_PATH);
    fs.appendFileSync(LEDGER_LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
};

const writeVvpat = ({ commitment, ballotPlain, receipt, signature }) => {
    const vvpatPath = path.join(VVPAT_DIR, `${commitment}.json`);
    ensureDir(vvpatPath);

    const payload = {
        ballotPlain,
        receipt: {
            ...receipt,
            signature,
        },
        timestamp: nowISO(),
    };

    fs.writeFileSync(
        vvpatPath,
        `${JSON.stringify(payload, null, 2)}\n`,
        "utf8"
    );

    return vvpatPath;
};

const summarizeArtifacts = ({
    cipherFiles,
    vvpatFiles,
    tallyFile,
    auditReportFile,
}) => {
    const cipherSummaries = cipherFiles.map((absolutePath) => ({
        path: relativePath(absolutePath),
        exists: fs.existsSync(absolutePath),
    }));

    const vvpatSummaries = vvpatFiles.map((absolutePath) => ({
        path: relativePath(absolutePath),
        exists: fs.existsSync(absolutePath),
    }));

    const tallySummary = tallyFile
        ? {
              path: relativePath(tallyFile),
              exists: fs.existsSync(tallyFile),
          }
        : null;

    const auditSummary = auditReportFile
        ? {
              path: relativePath(auditReportFile),
              exists: fs.existsSync(auditReportFile),
          }
        : null;

    return {
        cipherFiles: cipherSummaries.map((entry) => entry.path),
        vvpatFiles: vvpatSummaries.map((entry) => entry.path),
        ledgerLog: relativePath(LEDGER_LOG_PATH),
        tallyFile: tallySummary ? tallySummary.path : null,
        auditReportFile: auditSummary ? auditSummary.path : null,
        tokensDir: relativePath(TOKENS_DIR),
        ciphersDir: relativePath(CIPHER_DIR),
        cipherFilesStatus: cipherSummaries,
        vvpatFilesStatus: vvpatSummaries,
        tallyFileStatus: tallySummary,
        auditReportStatus: auditSummary,
    };
};

const ensureRaKeys = () => {
    if (!fs.existsSync(raPrivateKeyPath) || !fs.existsSync(raPublicKeyPath)) {
        generateSigningKeys();
    }
};

const runDemoInProcess = async (options = {}) => {
    const {
        quiet = false,
        electionId = DEFAULT_ELECTION_ID,
        title = DEFAULT_DEMO_TITLE,
        choices = DEFAULT_DEMO_CHOICES,
        voters = DEFAULT_DEMO_VOTERS,
    } = options;

    const ballotChoices = [...choices];
    const voterSpecs = voters.map((voter, index) => ({
        voterId: voter.voterId || `demo-voter-${index + 1}`,
        choice: voter.choice || ballotChoices[0],
    }));

    const log = quiet ? () => {} : console.log;

    cleanDemo({ quiet: true, electionId });

    log("\n=== Demo: In-Process End-to-End Flow ===");

    log("Reset demo environment and database state.");

    log("Generating authority keys...");
    ensureRaKeys();
    ensureLedgerKeys();
    const electionKeys = genKeypair(electionId);
    const electionPrivateKeyPath = electionKeys[constants.KEY_ALGO_BOX];

    const now = new Date();
    const startIso = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
    const endIso = new Date(now.getTime() + 60 * 1000).toISOString();

    insertElection({
        id: electionId,
        title,
        startIso,
        endIso,
        choices: ballotChoices,
    });

    log(
        `Created election '${electionId}' with choices ${ballotChoices.join(
            ", "
        )}.`
    );

    const tokenRecords = voterSpecs.map((voter) => {
        const token = issueToken({
            electionId,
            voterId: voter.voterId,
        });

        log(`Issued token ${token.tokenId} for ${voter.voterId}.`);

        return {
            ...token,
            voterId: voter.voterId,
            choice: voter.choice,
        };
    });

    const db = getDb();
    const cipherFiles = [];
    const vvpatFiles = [];
    const receipts = [];

    log("Casting demo ballots directly through ledger data APIs...");

    tokenRecords.forEach((tokenRecord, index) => {
        const ballotPlain = {
            electionId,
            voterId: tokenRecord.voterId,
            choice: tokenRecord.choice,
            timestamp: nowISO(),
        };

        const { voterId: _omittedVoter, ...anonymousBallot } = ballotPlain;

        const { ciphertextBase64, nonceBase64 } = encryptWithPublicKey(
            JSON.stringify(anonymousBallot),
            electionPrivateKeyPath
        );

        const commitment = computeCommitment(ciphertextBase64, nonceBase64);
        const receiptId = uuidv4();
        const timestamp = nowISO();
        const cipherFilePath = path.join(CIPHER_DIR, `${commitment}.bin`);

        ensureDir(cipherFilePath);
        fs.writeFileSync(
            cipherFilePath,
            Buffer.from(ciphertextBase64, "base64")
        );

        const ledgerRecord = {
            commitment,
            cipherRef: path.relative(PROJECT_ROOT, cipherFilePath),
            electionId,
            timestamp,
            receiptId,
        };

        const submissionTx = db.transaction(() => {
            const updateInfo = markTokenUsed(tokenRecord.tokenId);
            if (updateInfo.changes !== 1) {
                throw new Error(`Token ${tokenRecord.tokenId} already used`);
            }

            const insertInfo = insertLedgerEntry(ledgerRecord);
            return insertInfo.lastInsertRowid;
        });

        const ledgerIndex = Number(submissionTx());
        const receipt = {
            receiptId,
            ledgerIndex,
            commitment,
            electionId,
            timestamp,
        };

        const signature = signReceipt(receipt);

        appendLedgerLog({
            ...ledgerRecord,
            ledgerIndex,
            nonceB64: nonceBase64,
            voterIndex: index,
            receipt,
            signature,
            storedAt: nowISO(),
        });

        const vvpatPath = writeVvpat({
            commitment,
            ballotPlain: anonymousBallot,
            receipt,
            signature,
        });

        receipts.push({ ...receipt, signature });
        cipherFiles.push(cipherFilePath);
        vvpatFiles.push(vvpatPath);
        log(
            `Recorded ballot ${index + 1} (commitment ${commitment.slice(
                0,
                12
            )}...).`
        );
    });

    const endedIso = new Date(Date.now() - 60 * 1000).toISOString();
    db.prepare("UPDATE elections SET end_iso = ? WHERE id = ?").run(
        endedIso,
        electionId
    );

    log("Election end time fast-forwarded to allow tally.");

    const tally = await runTally(electionId, {
        privateKeyPath: electionPrivateKeyPath,
    });

    log("Tally generated and signed.");

    const auditReport = await auditElection(electionId, {
        electionPrivKeyPath: electionPrivateKeyPath,
        sampleRate: 1,
        minSample: voterSpecs.length,
    });

    log("Risk-limiting audit completed.");

    const tallyFile =
        fs
            .readdirSync(DATA_DIR)
            .filter((file) => file.startsWith(`tally-${electionId}-`))
            .map((file) => path.join(DATA_DIR, file))
            .sort()
            .pop() || null;

    const auditReportFile =
        fs
            .readdirSync(DATA_DIR)
            .filter((file) => file.startsWith(`audit-report-${electionId}-`))
            .map((file) => path.join(DATA_DIR, file))
            .sort()
            .pop() || null;

    const tokens = db
        .prepare(
            "SELECT tokenId, voterId, electionId, used FROM tokens WHERE electionId = ? ORDER BY issuedAt"
        )
        .all(electionId);

    const ledgerEntries = db
        .prepare(
            'SELECT "index" as ledgerIndex, commitment, cipherRef, receiptId FROM ledger WHERE electionId = ? ORDER BY "index" ASC'
        )
        .all(electionId);

    const artifacts = summarizeArtifacts({
        cipherFiles,
        vvpatFiles,
        tallyFile,
        auditReportFile,
    });

    if (!quiet) {
        log("\nArtifacts created:");
        log(JSON.stringify(artifacts, null, 2));

        log("\nSigned tally:");
        log(JSON.stringify(tally, null, 2));

        log("\nAudit report:");
        log(JSON.stringify(auditReport, null, 2));
    }

    return {
        electionId,
        voters: voterSpecs.map((item) => ({ ...item })),
        tokens,
        receipts,
        ledgerEntries,
        tally,
        auditReport,
        artifacts,
        electionKeyPaths: {
            box: relativePath(electionPrivateKeyPath),
        },
    };
};

const main = async () => {
    try {
        await runDemoInProcess();
    } catch (error) {
        console.error("Demo failed:", error);
        process.exitCode = 1;
    }
};

if (require.main === module) {
    main();
}

module.exports = {
    runDemoInProcess,
};
