const {Mwn, bot, log, emailOnError, TextExtractor} = require('../botbase');
const {formatSummary, saveWithBlacklistHandling} = require('./commons');

(async function() {

await bot.getTokensAndSiteInfo();

// uffoos, suppress rvslots warning, can't get that to work ...
bot.options.suppressAPIWarnings = true;

log(`[i] Started`);

let json = await bot.request({
	"action": "query",
	"list": "recentchanges",
	"rcstart": (function () {
		let d = new bot.Date();
		d.setHours(0,0,0,0);
		return d.toISOString();
	})(),
	"rcend": (function () {
		let d = new bot.Date().subtract(1, 'day');
		d.setHours(0,0,0,0);
		return d.toISOString();
	})(),
	"rcnamespace": "0",
	"rctag": "mw-new-redirect",
	"rcprop": "title|timestamp|user|comment",
	"rclimit": "max",
	"rctype": "edit"
});

const actions = json.query.recentchanges;
log(`[S] Fetched data from the API - ${actions.length} pages`);

let table = new Mwn.Table({
	// overflow-wrap: anywhere avoids a column from being widened due to one user
	// using a very large "word" (eg. an external link or a wikilink with underscores)
	// in the summary
	style: 'overflow-wrap: anywhere;'
});
table.addHeaders([
	{label: 'Time', style: 'width: 5em'},
	{label: 'Article', style: 'width: 17em;'},
	{label: 'User & summary', style: 'width: 17em;'},
	{label: 'Excerpt of former content'}
]);

const isRedirect = function(text) {
	// Don't require the # - while it's required for the redirect to be recognized, it seems
	// to be frequently skipped as a mistake, or done intentionally to link redirect
	// with wikidata
	return /^#?redirect\s*\[\[/i.test(text);
};

let count = 0;

for (let edit of actions) {

	log(`[+] Doing ${edit.title}`);

	// skip redirectifications as a result of AfD or RfD
	if (/^\[\[:?Wikipedia:(Redirects|Articles) for d.*?\]\]/.test(edit.comment) ||
		/^RFD closed as/.test(edit.comment)) {
		continue;
	}
	count++;

	// XXX: this is bad, since we know the timestamp, we should directly fetch that
	// revision. The description can also be fetched in the same call.
	let page = new bot.Page(edit.title),
		shortdesc;

	try {
		let revs = await page.history('content', 10, {
			rvsection: '0'
		});
		for (let rev of revs) {
			if (!rev.content) {
				continue;
			}
			if (!isRedirect(rev.content)) {
				edit.excerpt = TextExtractor.getExtract(rev.content, 250, 500);
				break;
			}
		}
		shortdesc = await page.getDescription();
	} catch(err) {
		if (err.code === 'missingtitle') {
			edit.excerpt = `[Page deleted. Can't get extract]`;
		}  else {
			log(`[W] Error on fetching history or description: ${err.stack}`);
			emailOnError(err, 'redirectify-watch non-fatal');
			// no need to throw
		}
	}

	table.addRow([
		new bot.Date(edit.timestamp).format('YYYY-MM-DD HH:mm'),
		`[[${edit.title}]] ${shortdesc ? `(<small>${shortdesc}</small>)` : ''}`,
		`[[User:${edit.user}|${edit.user}]]: <small>${formatSummary(edit.comment)} ({{history|1=${edit.title}|2=hist}})</small>`,
		edit.excerpt || ''
	]);

}

let report = new bot.Page('User:SDZeroBot/Redirectify Watch');
let revs = await report.history('timestamp|ids', 3);

let oldlinks = revs.map(rev => {
	return `[[Special:Permalink/${rev.revid}|${new bot.Date(rev.timestamp).subtract(1, 'day').format('D MMMM')}]]`;
}).join(' - ') + ' - {{history|2=older}}';

let wikitext =
`{{/header|count=${count}|date=${new bot.Date().subtract(1, 'day').format('D MMMM YYYY')}|oldlinks=${oldlinks}|ts=~~~~~}}<includeonly><section begin=lastupdate />${new bot.Date().toISOString()}<section end=lastupdate /></includeonly>

${table.getText()}
`;

await saveWithBlacklistHandling(report, TextExtractor.finalSanitise(wikitext), 'Updating report');

log(`[i] Finished`);

})().catch(err => emailOnError(err, 'redirectify-watch'));
