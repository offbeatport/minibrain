from minibrain.ml.context import run_child
from minibrain.models import download, transfer
from minibrain.storage import Space

if __name__ == "__main__":
    transfer.disk_space = lambda _path: Space(free=1024, total=1024)
    run_child(download.main)
