#!/usr/bin/env node
const { Command, InvalidArgumentError } = require("commander");

const {
    generateSigningKeys,
    issueToken,
    raPrivateKeyPath,
    raPublicKeyPath,
} = require("./tokenService");

const program = new Command();
program
    .name("btp-ra")
    .description("Registration Authority CLI for voter token issuance");

program
    .command("gen-keys")
    .description("Generate signing keypair for the registration authority")
    .action(() => {
        const { privateKeyPath, publicKeyPath } = generateSigningKeys();
        console.log(
            `Generated RA signing keys:\n  Private: ${privateKeyPath}\n  Public: ${publicKeyPath}`
        );
    });

program
    .command("issue-token")
    .description("Issue a voting token for a given election and voter")
    .requiredOption("--election <id>", "Election identifier")
    .requiredOption("--voter <voterId>", "Voter identifier")
    .action((options) => {
        try {
            const { tokenId, tokenJwt, tokenFilePath } = issueToken({
                electionId: options.election,
                voterId: options.voter,
            });

            console.log(
                `Token issued:\n  tokenId: ${tokenId}\n  jwt: ${tokenJwt}\n  saved: ${tokenFilePath}`
            );
        } catch (error) {
            console.error(`Failed to issue token: ${error.message}`);
            process.exitCode = 1;
        }
    });

if (require.main === module) {
    program.parse(process.argv);
}

module.exports = program;
