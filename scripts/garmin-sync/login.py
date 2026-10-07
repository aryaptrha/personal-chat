"""One-time Garmin Connect login for the sync workflow.

Asks for your email, password and MFA code, then writes the session tokens to a
file. Paste that file's contents into the GARMIN_TOKENS GitHub secret.

Run it in your own terminal. The tokens grant full access to your Garmin account,
so don't print them anywhere that keeps a log.

The default location is deliberately not ~/.garminconnect: if Garmin rotates
refresh tokens, a session shared with Claude Desktop's garmin-mcp would be
invalidated by whichever side refreshed second.
"""

from __future__ import annotations

import argparse
import getpass
from pathlib import Path

from garminconnect import Garmin
from garminconnect.client import token_file_path

DEFAULT_DIR = "~/.garminconnect-github-sync"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--token-dir",
        default=DEFAULT_DIR,
        help=f"directory to write garmin_tokens.json into (default {DEFAULT_DIR})",
    )
    args = parser.parse_args()

    email = input("Garmin email: ").strip()
    password = getpass.getpass("Garmin password: ")
    garmin = Garmin(email, password, prompt_mfa=lambda: input("MFA code: ").strip())
    garmin.login()

    token_dir = str(Path(args.token_dir).expanduser())
    garmin.client.dump(token_dir)
    print(f"Logged in. Tokens written to {token_file_path(token_dir)}")


if __name__ == "__main__":
    main()
