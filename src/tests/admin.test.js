const path = require("path");
const { spawnSync } = require("child_process");

const { getDb } = require("../common/db");

const cliPath = path.resolve(__dirname, "../admin/cli.js");
const db = getDb();

describe("admin CLI", () => {
    const electionId = "e1";

    beforeAll(() => {
        db.prepare("DELETE FROM elections WHERE id = ?").run(electionId);
    });

    test("create-election inserts a record", () => {
        const result = spawnSync(
            process.execPath,
            [
                cliPath,
                "create-election",
                "--id",
                electionId,
                "--title",
                "Integration Test Election",
                "--start",
                "2025-01-01T00:00:00.000Z",
                "--end",
                "2025-01-02T00:00:00.000Z",
                "--choices",
                "Alpha,Beta,Gamma",
            ],
            {
                encoding: "utf8",
            }
        );

        if (result.status !== 0) {
            const stderr = result.stderr || "";
            throw new Error(`CLI execution failed: ${stderr}`);
        }

        const row = db
            .prepare(
                "SELECT id, title, start_iso, end_iso, choices_json FROM elections WHERE id = ?"
            )
            .get(electionId);

        expect(row).toBeDefined();
        expect(row.title).toBe("Integration Test Election");
        expect(row.start_iso).toBe("2025-01-01T00:00:00.000Z");
        expect(row.end_iso).toBe("2025-01-02T00:00:00.000Z");
        expect(JSON.parse(row.choices_json)).toEqual([
            "Alpha",
            "Beta",
            "Gamma",
        ]);
    });
});
