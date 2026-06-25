# CLAUDE.md — Prototype (Unreal Engine 5.5)

Guidance for AI assistants working in this repository.

## Project

- Unreal Engine **5.5**, C++ third-person 3D game. Module/project name: `Prototype`.
- The cloud workspace is a **headless Linux container** — the UE Editor, builds,
  and packaging happen on the **user's local machine** (Windows/macOS + UE 5.5).
  Do not attempt to run the editor, UnrealBuildTool, or `playwright`-style runs
  against the editor here.

## What can be done in the cloud workspace

- Author/edit C++ (`Source/**`), build files (`*.Build.cs`, `*.Target.cs`),
  and config (`Config/*.ini`).
- Code review, refactors, adding new gameplay classes.

## What must be done locally by the user

- Anything in the editor: levels (`.umap`), Blueprints/assets (`.uasset`),
  importing art/audio, lighting, packaging. These are binary and tracked via
  Git LFS (`.gitattributes`).

## Conventions

- Follow Unreal's C++ coding standard: tabs for indentation; `A`/`U`/`F`/`E`
  type prefixes; `UPROPERTY`/`UFUNCTION` macros where reflection is needed.
- Keep `.generated.h` includes last in header include order.
- New runtime classes go under `Source/Prototype/`. Add new module dependencies
  in `Prototype.Build.cs`.

## Renaming the project

`Prototype` appears in: `Prototype.uproject`, both `*.Target.cs`, the module
folder + `Prototype.Build.cs` + `Prototype.{h,cpp}`, the `PROTOTYPE_API` macro,
class names, and redirects in `DefaultEngine.ini`. Rename all together.
