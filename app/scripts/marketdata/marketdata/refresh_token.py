"""Generate today's Dhan token by PIN + TOTP. Run daily by cron; safe to run by hand.

    python -m marketdata.refresh_token

Prints only whether it worked and when the token expires - never the token.
"""
import sys

from .dhan import TokenError, generate_token, totp_configured


def main():
    if not totp_configured():
        print("DHAN_PIN and DHAN_TOTP_SECRET must both be set in .env")
        sys.exit(1)
    try:
        expiry = generate_token()
    except TokenError as e:
        print(f"FAILED: {e}")
        sys.exit(1)
    print(f"token OK, valid until {expiry}")


if __name__ == "__main__":
    main()
