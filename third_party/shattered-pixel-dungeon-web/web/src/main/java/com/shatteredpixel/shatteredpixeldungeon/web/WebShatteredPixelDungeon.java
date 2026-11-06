/*
 * Pixel Dungeon
 * Copyright (C) 2012-2015 Oleg Dolya
 *
 * Shattered Pixel Dungeon
 * Copyright (C) 2014-2026 Evan Debenham
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

package com.shatteredpixel.shatteredpixeldungeon.web;

import com.shatteredpixel.shatteredpixeldungeon.Dungeon;
import com.shatteredpixel.shatteredpixeldungeon.GamesInProgress;
import com.shatteredpixel.shatteredpixeldungeon.SPDSettings;
import com.shatteredpixel.shatteredpixeldungeon.ShatteredPixelDungeon;
import com.shatteredpixel.shatteredpixeldungeon.scenes.GameScene;
import com.watabou.noosa.Game;
import com.watabou.utils.FileUtils;
import com.watabou.utils.PlatformSupport;
import com.shatteredpixel.shatteredpixeldungeon.Badges;
import com.shatteredpixel.shatteredpixeldungeon.journal.Journal;
import org.teavm.jso.JSBody;
import org.teavm.jso.JSFunctor;
import org.teavm.jso.JSObject;

import java.io.IOException;

/**
 * Browser lifecycle adjustments which should not change native game behavior.
 */
public class WebShatteredPixelDungeon extends ShatteredPixelDungeon {

	private static final long AUTO_SAVE_INTERVAL_MS = 3_000;

	private long nextAutoSaveAt;
	private boolean hostPaused;

	public WebShatteredPixelDungeon(PlatformSupport platform) {
		super(platform);
	}

	@Override
	public void create() {
		// A tab can be reloaded before the first-run tutorial is completed. The
		// normal intro flow always opens a new slot, so recover the existing run.
		if (SPDSettings.intro() && hasSavedGame()) {
			SPDSettings.intro(false);
		}

		super.create();
		// Hulinger integration, 2026-11-06: keep all game serialization in Java;
		// the host only receives a completed-save notification and opaque files.
		installHostControls(this::saveForHost, () -> hostPaused = true);
		notifyReady();
	}

	@Override
	public void render() {
		if (hostPaused) return;
		super.render();

		// IndexedDB writes triggered by pagehide may be cancelled by a reload.
		// Save stable turns periodically so refreshing loses at most a few seconds.
		if (Game.realTime >= nextAutoSaveAt
				&& Game.scene() instanceof GameScene
				&& Dungeon.hero != null
				&& Dungeon.hero.ready) {
			nextAutoSaveAt = Game.realTime + AUTO_SAVE_INTERVAL_MS;
			saveForHost();
		}
	}

	private boolean saveForHost() {
		if (hostPaused) return false;
		if (Game.scene() instanceof GameScene && (Dungeon.hero == null || !Dungeon.hero.ready)) return false;
		try {
			if (Game.scene() instanceof GameScene) Dungeon.saveAll();
			Badges.saveGlobal();
			Journal.saveGlobal();
			notifySaved();
			return true;
		} catch (IOException e) {
			reportException(e);
			notifySaveError();
			return false;
		}
	}

	@Override
	public void pause() {
		super.pause();
		if (!hostPaused) notifySaved();
	}

	@JSFunctor
	private interface SaveAction extends JSObject { boolean run(); }
	@JSFunctor
	private interface PauseAction extends JSObject { void run(); }

	@JSBody(params = {"save", "pause"}, script = "window.HulingerDungeon.save = save; window.HulingerDungeon.pause = pause;")
	private static native void installHostControls(SaveAction save, PauseAction pause);
	@JSBody(script = "window.dispatchEvent(new Event('hulinger-game-ready'));")
	private static native void notifyReady();
	@JSBody(script = "window.dispatchEvent(new Event('hulinger-game-saved'));")
	private static native void notifySaved();
	@JSBody(script = "window.dispatchEvent(new Event('hulinger-game-save-error'));")
	private static native void notifySaveError();

	private boolean hasSavedGame() {
		for (int slot = 1; slot <= GamesInProgress.MAX_SLOTS; slot++) {
			if (FileUtils.fileLength("game" + slot + "/game.dat") > 1) {
				return true;
			}
		}
		return false;
	}
}
