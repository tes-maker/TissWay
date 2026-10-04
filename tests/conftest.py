import pytest

from tissway import config


@pytest.fixture(autouse=True)
def default_settings():
    """Every test starts from the default settings, whatever profile sits in the working directory."""
    config.reset()
    yield config.settings
    config.reset()
