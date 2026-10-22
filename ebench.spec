# Build the Mac app: uv run pyinstaller ebench.spec  ->  dist/Lagreton eBench.app
# The icon is assets/icon.svg; after changing it, remake assets/icon.icns with rsvg-convert (16-1024 px) and iconutil.
import tomllib

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

version = tomllib.load(open("pyproject.toml", "rb"))["project"]["version"]

a = Analysis(
    ["ebench/__main__.py"],
    pathex=["."],
    # esptool and espefuse load their flasher stubs and eFuse maps as data files, and some chip modules by name
    datas=[("ebench/ui", "ebench/ui"), *collect_data_files("esptool"), *collect_data_files("espefuse")],
    hiddenimports=collect_submodules("esptool") + collect_submodules("espefuse"),
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="Lagreton eBench", console=False)
coll = COLLECT(exe, a.binaries, a.datas, name="Lagreton eBench")
app = BUNDLE(
    coll,
    name="Lagreton eBench.app",
    icon="assets/icon.icns",
    bundle_identifier="com.lagreton.ebench",
    version=version,
    info_plist={"NSHighResolutionCapable": True, "LSMinimumSystemVersion": "13.0"},
)
