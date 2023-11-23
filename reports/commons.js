const {bot, Mwn, log, emailOnError} = require('../botbase');
const OresUtils = require('./OresUtils');

/**
 * @param {Object} tableInfo
 * @returns {Promise<void>}
 */
async function populateWikidataShortdescs(tableInfo) {
	/* GET WIKIDATA SHORTDESCS */
	const wdbot = new Mwn({
		...bot.options,
		apiUrl: 'https://www.wikidata.org/w/api.php'
	});
	wdbot.options.defaultParams.maxlag = 1000; // disable maxlag, we are not doing any write operations
	delete wdbot.options.defaultParams.assert;
	for await (let json of wdbot.massQueryGen({
		"action": "wbgetentities",
		"sites": "enwiki",
		"titles": Object.keys(tableInfo).filter(title => !tableInfo[title].skip && !tableInfo[title].shortdesc),
		"props": "descriptions|sitelinks",
		"languages": "en",
		"sitefilter": "enwiki",
	})) {
		// eslint-disable-next-line no-unused-vars
		for (let [_id, {descriptions, sitelinks}] of Object.entries(json.entities)) {
			let tableentry = tableInfo[sitelinks?.enwiki?.title];
			if (!tableentry || tableentry.shortdesc) {
				continue;
			}
			tableentry.shortdesc = normaliseShortdesc(descriptions?.en?.value);
		}
	}
}

/**
 * @param {string} shortdesc
 * @returns {string}
 */
function normaliseShortdesc(shortdesc) {
	if (!shortdesc || shortdesc === 'Wikimedia list article') {
		return '';
	} else if (shortdesc === 'Disambiguation page providing links to topics that could be referred to by the same search' +
		' term') {
		return 'Disambiguation page';
	} else {
		return shortdesc;
	}
}

/**
 * @param {Object} tableInfo
 * @returns {Promise<void>}
 */
async function populateOresQualityRatings(tableInfo) {
	let revidTitleMap = Object.entries(tableInfo).reduce((map, [title, data]) => {
		if (!data.skip && data.revid) {
			map[data.revid] = title;
		}
		return map;
	}, {});
	await OresUtils.queryRevisions(['articlequality', 'draftquality'], Object.keys(revidTitleMap))
		.then(data => {
			for (let [revid, {articlequality, draftquality}] of Object.entries(data)) {
				Object.assign(tableInfo[revidTitleMap[revid]], {
					oresRating: {
						'Stub': 1, 'Start': 2, 'C': 3, 'B': 4, 'GA': 5, 'FA': 6 // sort-friendly format
					}[articlequality],
					oresBad: draftquality !== 'OK' // Vandalism/spam/attack, many false positives
				});
			}
			log(`[S] Got ORES result`);
		}).catch(err => {
			log(`[E] ORES query failed: ${err}`);
			emailOnError(err, 'g13-* ores (non-fatal)', false);
		});
}

// Helper functions for sorting
/**
 * @param {string} param
 * @param {Object} data1
 * @param {Object} data2
 * @returns {number}
 */
function promote(param, data1, data2) {
	if (data1[param] && !data2[param]) return -1;
	else if (!data1[param] && data2[param]) return 1;
	else return 0;
}
/**
 * @param {string} param
 * @param {Object} data1
 * @param {Object} data2
 * @returns {number}
 */
function demote(param, data1, data2) {
	if (data1[param] && !data2[param]) return 1;
	else if (!data1[param] && data2[param]) return -1;
	else return 0;
}
/**
 * @param {string} param
 * @param {Object} data1
 * @param {Object} data2
 * @returns {number}
 */
function sortDesc(param, data1, data2) {
	if (data1[param] === undefined || data1[param] === undefined) return 0;
	if (data1[param] > data2[param]) return -1;
	else if (data1[param] < data2[param]) return 1;
	else return 0;
}
/**
 * @param {string} param
 * @param {Object} data1
 * @param {Object} data2
 * @returns {number}
 */
function sortAsc(param, data1, data2) {
	if (data1[param] === undefined || data1[param] === undefined) return 0;
	if (data1[param] > data2[param]) return 1;
	else if (data1[param] < data2[param]) return -1;
	else return 0;
}

/**
 * Get page size not counting AFC templates and comments
 * @param {string} text
 * @returns {number}
 */
function AfcDraftSize(text) {
	text = text.replace(/<!--.*?-->/sg, ''); // remove comments
	let wkt = new bot.wikitext(text);
	wkt.parseTemplates({
		namePredicate: name => name.startsWith('AFC ') // AFC submission, AFC comment, etc
	});
	for (let template of wkt.templates) {
		wkt.removeEntity(template);
	}
	return wkt.getText().length;
}

/**
 * @param {string} text
 * @returns {string}
 */
function preprocessDraftForExtract(text) {
	let wkt = new bot.wikitext(text);
	wkt.parseTemplates({
		namePredicate: name => {
			return /(infobox|AfC submission)/i.test(name);
		}
	});
	for (let template of wkt.templates) {
		wkt.removeEntity(template);
	}
	return wkt.getText();
}

/**
 * @param {bot.page} page
 * @param {string} text
 * @param {string} summary
 * @returns {Promise}
 */
async function saveWithBlacklistHandling(page, text, summary) {
	return page.save(text, summary).catch(async err => {
		if (err.code === 'spamblacklist') {
			for (let site of err.spamblacklist.matches) {
				text = text.replace(
					new RegExp('https?:\\/\\/\\S*' + site, 'gi'),
					site
				);
			}
			await page.save(text, summary);
		} else {
			return Promise.reject(err);
		}
	});
}

/**
 * Format edit summary for inclusion in a bot report
 * @param {string} text
 * @returns {string}
 */
function formatSummary(text) {
	if (!text) { // no summary given or revdelled/suppressed summary
		return '';
	}
	return text
		// Ensure HTML comments are displayed as-is, and <div> and other tags don't render
		.replace(/</g, '&lt;')

		.replace(/\{\{.*?\}\}/g, '<nowiki>$&</nowiki>')
		.replace(/\[\[((?:Category|File|Image):.*?)\]\]/gi, '[[:$1]]')
		.replace(/~{3,5}/g, '<nowiki>$&</nowiki>');
}

/**
 * Format arbitrary text for inclusion in table cell.
 * Escapes the double pipe sequence.
 * @param {string} text
 * @returns {string}
 */
function escapeForTableCell(text) {
	return text.replace(/\|\|/g, '&#124;&#124;');
}

module.exports = {
	populateWikidataShortdescs,
	normaliseShortdesc,
	populateOresQualityRatings,
	comparators: {promote, demote, sortAsc, sortDesc},
	AfcDraftSize,
	preprocessDraftForExtract,
	saveWithBlacklistHandling,
	formatSummary,
	escapeForTableCell
};
