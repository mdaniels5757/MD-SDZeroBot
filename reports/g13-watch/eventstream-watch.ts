// DEPRECATED: replaced by g13-watch.ts which doesn't require
// eventstream watching component

import { bot, TextExtractor } from '../../botbase';
import { toolsdb, TOOLS_DB_HOST } from "../../db";
import { createLocalSSHTunnel } from "../../utils";
import { pageFromCategoryEvent, Route } from "../../eventstream-router/app";
import { preprocessDraftForExtract } from '../commons';

export default class g13Watch extends Route {
	name = "g13-watch";
	db: toolsdb;

	async init() {
		super.init();
		this.log(`[S] Started`);
		await bot.getSiteInfo();

		await createLocalSSHTunnel(TOOLS_DB_HOST);
		this.db = new toolsdb('g13watch_p');
		await this.db.run(`
			CREATE TABLE IF NOT EXISTS g13(
				name VARCHAR(255) UNIQUE,
				description VARCHAR(255),
				excerpt BLOB,
				size INT,
				ts TIMESTAMP NOT NULL
			) COLLATE 'utf8_unicode_ci'
		`); // use utf8_unicode_ci so that MariaDb allows a varchar(255) field to have unique constraint
		// max index column size is 767 bytes. 255*3 = 765 bytes with utf8, 255*4 = 1020 bytes with utf8mb4
	}

	filter(data) {
		return data.wiki === 'enwiki' &&
			data.type === 'categorize' &&
			data.title === 'Category:Candidates for speedy deletion as abandoned drafts or AfC submissions';
	}

	async worker(data) {
		let page = pageFromCategoryEvent(data);
		if (!page || !page.added) {
			return;
		}
		let title = page.title;
		// data.timestamp is *seconds* since epoch
		// This date object will be passed to db
		let ts = data.timestamp ? new bot.Date(data.timestamp * 1000) : null;
		this.log(`[+] Page ${title} at ${ts}`);
		let pagedata = await bot.read(title, {
			prop: 'revisions|description',
			rvprop: 'content|size'
		});
		let text = pagedata?.revisions?.[0]?.content;
		let size = pagedata?.revisions?.[0].size;
		let desc = pagedata?.description;
		if (desc && desc.size > 255) {
			desc = desc.slice(0, 250) + ' ...';
		}
		let extract = TextExtractor.getExtract(text, 300, 550, preprocessDraftForExtract);

		try {
			await this.db.run(`INSERT INTO g13 VALUES(?, ?, ?, ?, ?)`, [title, desc, extract, size, ts]);
		} catch (err) {
			if (err.code === 'ER_DUP_ENTRY') {
				this.log(`[W] ${title} entered category more than once`);
				return;
			}
			this.log(err);
		}
	}
}
