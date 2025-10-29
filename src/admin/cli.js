#!/usr/bin/env node
const { Command, InvalidArgumentError } = require("commander");

const { insertElection, listElections } = require("../common/db");

const program = new Command();
program
    .name("btp-admin")
    .description("Administrative CLI for managing prototype elections");

const parseIso = (value, optionName) => {
    const asDate = new Date(value);
    if (Number.isNaN(asDate.getTime())) {
        throw new InvalidArgumentError(
            `${optionName} must be an ISO-8601 date string`
        );
    }

    return value;
};

const parseChoices = (value) => {
    const items = value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

    if (!items.length) {
        throw new InvalidArgumentError(
            "choices must contain at least one entry"
        );
    }

    return items;
};

program
    .command("create-election")
    .description("Create a new election entry")
    .requiredOption("--id <id>", "Election identifier")
    .requiredOption("--title <title>", "Election title")
    .requiredOption("--start <iso>", "Start time (ISO)", (value) =>
        parseIso(value, "--start")
    )
    .requiredOption("--end <iso>", "End time (ISO)", (value) =>
        parseIso(value, "--end")
    )
    .requiredOption(
        "--choices <choices>",
        "Comma separated list of ballot choices",
        parseChoices
    )
    .action((options) => {
        try {
            insertElection({
                id: options.id,
                title: options.title,
                startIso: options.start,
                endIso: options.end,
                choices: options.choices,
            });

            console.log(
                `Election '${
                    options.id
                }' created with choices: ${options.choices.join(", ")}`
            );
        } catch (error) {
            if (error && error.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
                console.error(
                    `Election with id '${options.id}' already exists.`
                );
                process.exitCode = 1;
                return;
            }

            console.error(`Failed to create election: ${error.message}`);
            process.exitCode = 1;
        }
    });

program
    .command("list-elections")
    .description("List configured elections")
    .action(() => {
        const elections = listElections();

        if (!elections.length) {
            console.log("No elections configured.");
            return;
        }

        elections.forEach((row) => {
            const choiceList = Array.isArray(row.choices)
                ? row.choices.join(", ")
                : row.choices_json;
            console.log(`[${row.id}] ${row.title}`);
            console.log(`  Window: ${row.start_iso} -> ${row.end_iso}`);
            console.log(`  Choices: ${choiceList}`);
        });
    });

if (require.main === module) {
    program.parse(process.argv);
}

module.exports = program;
