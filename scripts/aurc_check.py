"""Run aurc's front end (lexer, parser, type checker) over many sources.

    python aurc_check.py <auric-lang dir> <sources.json> <results.json>

sources.json holds a list of program texts; results.json gets, for each, the
first error aurc raises: {"ok": true}, {"ok": false, "stage", "message",
"line", "col"}, or {"crash": "..."} when aurc fails with something other than
an AuricError.
"""
import json
import os
import sys


def main() -> None:
    auric_lang, sources_path, results_path = sys.argv[1:4]
    # Via the working directory, so MSYS2's Python turns "D:/..." into a path
    # its imports understand.
    os.chdir(auric_lang)
    sys.path.insert(0, os.getcwd())
    from compiler import AuricError, check_source

    with open(sources_path, encoding="utf-8") as f:
        sources = json.load(f)
    results = []
    for src in sources:
        try:
            check_source(src)
            results.append({"ok": True})
        except AuricError as e:
            results.append({"ok": False, "stage": e.stage, "message": e.message,
                            "line": e.line, "col": e.col})
        except Exception as e:  # noqa: BLE001 - aurc itself crashed
            results.append({"crash": f"{type(e).__name__}: {e}"})
    with open(results_path, "w", encoding="utf-8") as f:
        json.dump(results, f)


if __name__ == "__main__":
    main()
