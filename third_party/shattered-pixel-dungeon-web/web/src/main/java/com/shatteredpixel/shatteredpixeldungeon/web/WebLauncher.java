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

import com.badlogic.gdx.Files;
import com.github.xpenatan.gdx.teavm.backends.web.WebApplication;
import com.github.xpenatan.gdx.teavm.backends.web.WebApplicationConfiguration;
import com.watabou.noosa.Game;
import com.watabou.utils.FileUtils;
import org.teavm.jso.JSBody;

public class WebLauncher {

	public static void main(String[] args) {
		Game.version = "3.3.8-WEB";
		Game.versionCode = 896;

		FileUtils.setDefaultFileProperties(Files.FileType.Local, "shattered-pixel-dungeon/");
		FileUtils.setBundleCompression(false);

		WebApplicationConfiguration config = new WebApplicationConfiguration("canvas");
		config.width = 0;
		config.height = 0;
		// Hulinger integration, 2026-11-06: isolate both preference and file stores
		// for the authenticated account's current browser run. The host hydrates
		// these stores before invoking main; the game never selects an account.
		config.storagePrefix = storagePrefix();
		config.localStoragePrefix = databaseName();
		config.showDownloadLogs = false;
		config.preloadListener = assetLoader -> assetLoader.loadScript("freetype.js");

		new WebApplication(new WebShatteredPixelDungeon(new WebPlatformSupport()), config);
	}

	@JSBody(script = "return window.HulingerDungeon.storagePrefix;")
	private static native String storagePrefix();

	@JSBody(script = "return window.HulingerDungeon.databaseName;")
	private static native String databaseName();
}
