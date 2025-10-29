#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { Command, InvalidArgumentError } = require("commander");

const { readJson } = require("../common/utils");
const {
    generateVoterKeys,
    buildBallotPlain,
    encryptBallot,
    submitBallot,
    recordVvpat,
    voterKeyPaths,
    DEFAULT_LEDGER_URL,
} = require("./voter");

const ELECTION_PUBLIC_KEY_FILE = path.resolve(
    process.cwd(),
    "src",
    "keys",
    "election-pub.json"
);

const program = new Command();
program
    .name("btp-voter")
    .description("Voter CLI for casting encrypted ballots")
    .showHelpAfterError(true);

const base64UrlToBase64 = (input) => {
    const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
    const padLength = (4 - (normalized.length % 4)) % 4;
    return normalized + "=".repeat(padLength);
};

const decodeJwtPayload = (token) => {
    const parts = token.split(".");
    if (parts.length < 2) {
        throw new Error("Invalid JWT structure");
    }

    const payload = Buffer.from(base64UrlToBase64(parts[1]), "base64").toString(
        "utf8"
    );
    return JSON.parse(payload);
};

const assertFileExists = (filePath, label) => {
    if (!fs.existsSync(filePath)) {
        throw new InvalidArgumentError(`${label} not found at ${filePath}`);
    }
};

program
    .command("gen-keys")
    .description("Generate keys for a voter")
    .requiredOption("--voter <id>", "Voter identifier")
    .action((options) => {
        try {
            const { publicKeyPath, privateKeyPath } = generateVoterKeys(
                options.voter
            );
            console.log("Generated voter keys:");
            console.log(`  Public: ${publicKeyPath}`);
            console.log(`  Private: ${privateKeyPath}`);
            process.exitCode = 0;
        } catch (error) {
            console.error(`Failed to generate voter keys: ${error.message}`);
            process.exitCode = 1;
        }
    });

program
    .command("cast")
    .description("Cast an encrypted ballot via the ledger service")
    .requiredOption("--election <id>", "Election identifier")
    .requiredOption("--token-file <path>", "Path to voter token JWT")
    .requiredOption("--choice <choice>", "Ballot choice")
    .option("--voter <id>", "Voter identifier override")
    .action(async (options) => {
        try {
            assertFileExists(options.tokenFile, "Token file");
            assertFileExists(
                ELECTION_PUBLIC_KEY_FILE,
                "Election public key file"
            );

            const tokenJwt = fs.readFileSync(options.tokenFile, "utf8").trim();
            if (!tokenJwt) {
                throw new Error("Token file is empty");
            }

            const tokenPayload = decodeJwtPayload(tokenJwt);
            const voterId = options.voter || tokenPayload.voterId;
            if (!voterId) {
                throw new Error(
                    "Unable to determine voterId from token or arguments"
                );
            }

            const ballotPlain = buildBallotPlain(
                options.election,
                voterId,
                options.choice
            );

            const voterKeys = voterKeyPaths(voterId);
            if (!fs.existsSync(voterKeys.publicKeyPath)) {
                generateVoterKeys(voterId);
            }

            const ballotSeal = encryptBallot(
                ballotPlain,
                ELECTION_PUBLIC_KEY_FILE
            );

            const submission = {
                tokenJwt,
                ciphertextB64: ballotSeal.ciphertextB64,
                nonceB64: ballotSeal.nonceB64,
                commitmentHex: ballotSeal.commitmentHex,
                electionId: options.election,
                timestamp: ballotPlain.timestamp,
            };

            const ledgerUrl = process.env.LEDGER_URL
                ? `${process.env.LEDGER_URL.replace(/\/$/, "")}${
                      process.env.LEDGER_URL.endsWith("/submit")
                          ? ""
                          : "/submit"
                  }`
                : DEFAULT_LEDGER_URL();

            const receipt = await submitBallot(submission, ledgerUrl);

            const vvpatPath = recordVvpat(
                ballotSeal.commitmentHex,
                ballotPlain,
                receipt
            );

            console.log("Ballot submitted successfully:");
            console.log(JSON.stringify(receipt, null, 2));
            console.log(`VVPAT stored at: ${vvpatPath}`);
            process.exitCode = 0;
        } catch (error) {
            console.error(`Ballot submission failed: ${error.message}`);
            process.exitCode = 1;
        }
    });

if (require.main === module) {
    program.parse(process.argv);
}

module.exports = program;
