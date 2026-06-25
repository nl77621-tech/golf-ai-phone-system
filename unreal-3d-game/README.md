# Prototype — Unreal Engine 5.5 3D Game

A C++ third-person 3D game project scaffolded for **Unreal Engine 5.5**.

This repository holds the *source* of the project: C++ code, config, and (via Git
LFS) binary assets. The Unreal **Editor itself runs on your local machine** —
Windows or macOS with UE 5.5 installed. This cloud workspace is used for writing
and reviewing code, not for running the editor (it's a headless Linux container
with no GPU).

---

## Prerequisites (local machine)

1. **Unreal Engine 5.5** — install via the [Epic Games Launcher](https://www.unrealengine.com/download).
2. **A C++ toolchain:**
   - Windows: Visual Studio 2022 with the *Game development with C++* workload (include the *Unreal Engine installer* component).
   - macOS: Xcode (latest).
3. **Git LFS** — `git lfs install` once per machine. Binary assets (`.uasset`,
   `.umap`, textures, audio, FBX) are stored via LFS; see `.gitattributes`.

## First-time setup

```bash
git clone <this-repo-url>
cd <repo>
git lfs install
git lfs pull
```

Then generate IDE project files and build:

- **Windows:** right-click `Prototype.uproject` → *Generate Visual Studio project
  files*, open `Prototype.sln`, build (Development Editor / Win64), or just
  double-click `Prototype.uproject` and let it compile.
- **macOS:** right-click `Prototype.uproject` → *Generate Xcode project files*,
  open and build, or double-click the `.uproject`.

The first compile of a fresh checkout takes a while — `Binaries/`,
`Intermediate/`, `Saved/`, and `DerivedDataCache/` are all gitignored and get
regenerated locally.

## What's in here

```
Prototype.uproject          Project descriptor (engine 5.5, module list)
Config/                     Project settings (engine, input, game, editor)
Source/
  Prototype.Target.cs       Game build target
  PrototypeEditor.Target.cs Editor build target
  Prototype/
    Prototype.Build.cs      Module dependencies
    Prototype.{h,cpp}       Primary game module
    PrototypeCharacter.*    Third-person player character
    PrototypeGameMode.*     Default game mode
```

### Input

The character uses the **classic axis/action input mappings** in
`Config/DefaultInput.ini` (WASD + mouse + gamepad). This keeps the scaffold fully
buildable from source with no binary input assets. When you want the modern UE 5
workflow, migrate to **Enhanced Input** (create Input Action and Input Mapping
Context assets in the editor) — ask and I can guide that conversion.

### Assets, maps, and Blueprints

Levels (`.umap`) and Blueprint/asset files (`.uasset`) are created **in the
editor** and committed via Git LFS. There is no starter map in this scaffold yet
— create one in the editor (*File → New Level → Basic*), drop in a Player Start,
set it as the editor/game default map in *Project Settings → Maps & Modes*, then
commit it.

## Working with Claude on this project

- Code, config, and build-file changes: handled here in the cloud workspace via git.
- Anything requiring the editor (placing actors, authoring Blueprints, importing
  art, lighting, packaging builds): done by you locally — I'll give exact steps.
- Renaming the project/module later is invasive (the name `Prototype` is baked
  into target files, the module, class API macros, and redirects). Easiest to
  pick the final name early — tell me and I'll do the rename across all files.

## License

TBD.
