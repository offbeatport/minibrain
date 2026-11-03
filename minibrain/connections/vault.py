from pathlib import Path

from minibrain.encryption.envelope import EnvelopeError
from minibrain.encryption.keys import EncryptionError, key_file, keys_for
from minibrain.encryption.providers import KeyUnavailableError
from minibrain.encryption.secrets import open_text, seal_text
from minibrain.settings import Settings

UNREADABLE = "the stored secret cannot be decrypted with this install's master key; enter it again"


class VaultError(Exception):
    pass


def key_path(settings: Settings) -> Path:
    return key_file(settings).path


def seal(settings: Settings, plaintext: str, context: str) -> str:
    try:
        return seal_text(keys_for(settings), plaintext, context)
    except (KeyUnavailableError, EncryptionError) as error:
        raise VaultError(str(error)) from error


def unseal(settings: Settings, token: str, context: str) -> str:
    try:
        return open_text(keys_for(settings), token, context)
    except KeyUnavailableError as error:
        raise VaultError(str(error)) from error
    except (EnvelopeError, EncryptionError, UnicodeDecodeError) as error:
        raise VaultError(UNREADABLE) from error
