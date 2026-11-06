# Shattered Pixel Dungeon Web

This repository is a browser-playable Web port of
[Shattered Pixel Dungeon](https://github.com/00-Evan/shattered-pixel-dungeon).
It keeps the original game source available and adds a TeaVM/libGDX web target
so the game can run from a static web directory.

This is not an official Shattered Pixel Dungeon release. The original game is
created and maintained by Evan Debenham, and the official project, releases,
website, and support links remain the best place to follow and support the
game:

- Official website: <https://shatteredpixel.com/shatteredpd/>
- Original source: <https://github.com/00-Evan/shattered-pixel-dungeon>
- Official releases: <https://github.com/00-Evan/shattered-pixel-dungeon/releases>

## Why This Repository Is Public

Shattered Pixel Dungeon is free software under the GNU General Public License.
This Web port is a modified version of that GPL project, so the right thing to
do is to publish the corresponding source code, preserve the license, and make
the changes easy to inspect.

The goal is simple:

- respect the original project's license and authorship;
- keep the Web build reproducible from source;
- make it clear what changed for browser support;
- provide a playable experiment for people who want to try Shattered Pixel
  Dungeon in a browser.

## What This Fork Adds

The upstream project already supports Android, iOS, and desktop builds. This
fork adds a Web target built with TeaVM and the libGDX TeaVM backend.

Main Web-specific work:

- `:web` Gradle module for TeaVM compilation;
- browser launcher and Web platform support classes;
- static Web output under `web/build/dist/webapp`;
- Web-friendly save/reload handling for browser lifecycle behavior;
- WebGL-safe vertex-buffer paths for dynamic text, effects, tilemap updates,
  and partial VBO uploads;
- browser font and file handling adjustments needed by the TeaVM runtime.

## Current Status

The Web build is playable in a modern browser. The current build has been
tested through:

- title screen and hero selection;
- first-floor entry and tutorial guidebook flow;
- room-to-room movement, doors, visibility updates, and map exploration;
- combat with multiple first-floor enemies;
- browser refresh, save-slot detection, save details, and continuing back into
  the explored dungeon;
- generated `app.js` syntax validation.

This is still an experimental Web port. It has not been tested through a full
run, later dungeon regions, every item interaction, mobile browser controls, or
production hosting under heavy traffic.

One browser warning is expected on first load in automated tests:

```text
The AudioContext was not allowed to start.
```

That is Chrome's normal autoplay policy for Web Audio. It should resume after a
user gesture and is not a game-state error.

## Requirements

- JDK 17 or newer is recommended.
- A modern desktop browser with WebGL support.
- Python 3 or any small static file server for local testing.

The Gradle wrapper is included, so a separate Gradle install is not required.

## Build the Web Version

From the repository root:

```bash
./gradlew :web:webBuild
```

The browser app is generated here:

```text
web/build/dist/webapp
```

## Run Locally

After building, serve the generated static directory:

```bash
cd web/build/dist/webapp
python3 -m http.server 8081 --bind 127.0.0.1
```

Then open:

```text
http://127.0.0.1:8081/
```

You can also use the Gradle helper task:

```bash
./gradlew :web:webRun
```

That task builds and serves the Web version on:

```text
http://localhost:8080/
```

## Verify a Build

A quick local verification loop:

```bash
./gradlew :desktop:classes :web:webBuild --stacktrace
node --check web/build/dist/webapp/app.js
```

Then open the local server and confirm that a new game can enter the dungeon,
move, fight, refresh, and continue from the save slot.

## Repository Layout

Important paths for the Web port:

```text
web/build.gradle
web/src/main/java/com/shatteredpixel/shatteredpixeldungeon/web/
SPD-classes/src/main/java/com/watabou/glwrap/Vertexbuffer.java
SPD-classes/src/main/java/com/watabou/noosa/
core/src/main/java/com/shatteredpixel/shatteredpixeldungeon/scenes/GameScene.java
```

Generated build output is intentionally not committed.

## License

This project is distributed under the GNU General Public License version 3, as
in the original Shattered Pixel Dungeon source. See
[LICENSE.txt](LICENSE.txt).

Because this is a GPL-derived work, redistribution of binaries or hosted builds
must preserve the same license obligations, including access to the
corresponding source code.

## Credits

- Shattered Pixel Dungeon: Evan Debenham
- Pixel Dungeon: Watabou
- This repository: a Web build adaptation of the GPL Shattered Pixel Dungeon
  source

If you enjoy the game, please support the official Shattered Pixel Dungeon
project and its original author.
