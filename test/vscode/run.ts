// Runs test/vscode/suite.ts inside VS Code, with a throwaway profile.
//
//   npm run test:vscode
//
// $VSCODE_PATH picks an installed Code executable (else one is downloaded);
// $AURIC_LANG the auric-lang folder for the build tests (default
// ../aurora/auric-lang; those tests are skipped when it is missing).

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
    const root = path.resolve(__dirname, "..", "..", "..");
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "auric-vscode-"));
    try {
        await runTests({
            vscodeExecutablePath: process.env.VSCODE_PATH || undefined,
            extensionDevelopmentPath: root,
            extensionTestsPath: path.join(__dirname, "suite"),
            launchArgs: [
                path.join(root, "test", "fixtures"),
                "--disable-extensions",
                "--disable-workspace-trust",
                `--user-data-dir=${path.join(scratch, "user-data")}`,
                `--extensions-dir=${path.join(scratch, "extensions")}`,
            ],
            extensionTestsEnv: {
                AURIC_LANG: path.resolve(process.env.AURIC_LANG ?? path.join(root, "..", "aurora", "auric-lang")),
                AURIC_TEST_OUT: path.join(scratch, "out"),
            },
        });
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
