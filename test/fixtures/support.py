"""Load the supplied, unchanged Python protocol as an independent test peer."""
import importlib.util
import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent / 'reference_protocol'
spec = importlib.util.spec_from_file_location('xiaomi_native_protocol', ROOT / '__init__.py', submodule_search_locations=[str(ROOT)])
package = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = package
spec.loader.exec_module(package)
