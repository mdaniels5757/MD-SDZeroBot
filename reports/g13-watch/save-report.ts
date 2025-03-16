// DEPRECATED: replaced by g13-watch.ts

// This report relies on ToolsDB g13watch_p database maintained using
// eventstream-watch.ts

import { bot, emailOnError, log, Mwn } from "../../botbase";
import { toolsdb, TOOLS_DB_HOST } from "../../db";
import { createLocalSSHTunnel } from "../../utils";
const { saveWithBlacklistHandling } = require('../commons');

(async function() {

	await Promise.all([
		bot.getTokensAndSiteInfo(),
		createLocalSSHTunnel(TOOLS_DB_HOST)
	]);

	const db = new toolsdb('g13watch_p');
	log('[S] Connected to the g13 database.');

	let table = new Mwn.table();
	table.addHeaders([
		{label: 'Date', style: 'width: 5em'},
		{label: 'Draft', style: 'width: 18em'},
		{label: 'Excerpt'},
		{label: 'Size', style: 'width: 4em'}
	]);

	let end = (function () {
		let d = new bot.Date();
		d.setUTCHours(0,0,0,0);
		return d;
	})();
	let start = (function () {
		let d = new bot.Date().subtract(24, 'hours');
		d.setUTCHours(0,0,0,0);
		return d;
	})();

	const result = await db.query(`
		SELECT * FROM g13
		WHERE ts BETWEEN ? AND ?
	`, [
		start.format('YYYY-MM-DD HH:mm:ss'),
		end.format('YYYY-MM-DD HH:mm:ss')
	]);

	result.forEach(row => {
		let page = `[[${row.name}]]`;
		if (row.description) {
			page += ` <small>${row.description}</small>`
		}

		table.addRow([
			new bot.Date(row.ts).format('YYYY-MM-DD HH:mm'),
			page,
			row.excerpt || '',
			row.size || ''
		]);
	});

	let wikitable = table.getText();
	let yesterday = new bot.Date().subtract(1, 'day');

	let page = new bot.Page('User:SDZeroBot/G13 Watch');

	let oldlinks = '';
	try {
		oldlinks = (await page.history(['timestamp', 'ids'], 3)).map(rev => {
			let date = new bot.Date(rev.timestamp).subtract(24, 'hours');
			return `[[Special:Permalink/${rev.revid}|${date.format('D MMMM')}]]`;
		}).join(' - ') + ' - {{history|2=older}}';
	} catch (e) {}

	let text = `{{/header|count=${result.length}|date=${yesterday.format('D MMMM YYYY')}|ts=~~~~~|oldlinks=${oldlinks}}}<includeonly><section begin=lastupdate />${new bot.Date().toISOString()}<section end=lastupdate /></includeonly>`
		+ `\n\n${wikitable}`;

	await saveWithBlacklistHandling(page, text, 'Updating G13 report');

	// Delete data more than 3 days old:
	await db.run(`DELETE FROM g13 WHERE ts < FROM_UNIXTIME(?)`, [
		Math.round(new bot.Date().subtract(72, 'hours').getTime() / 1000)
	]);
	db.end();

	log(`[S] Deleted data more than 3 days old`);

	log(`[i] Finished`);

})().catch(err => emailOnError(err, 'g13-watch-save'));
