import { argv, bot, emailOnError, log, mwn, TextExtractor } from "../botbase";
import { enwikidb, SQLError } from "../db";
import { Template } from "../../mwn/build/wikitext";
import { arrayChunk, lowerFirst, readFile, writeFile } from "../utils";
import { NS_CATEGORY, NS_FILE } from "../namespaces";
import { MwnDate } from "../../mwn/build/date";
import { formatSummary } from "../reports/commons";

export const BOT_NAME = 'SDZeroBot';
export const TEMPLATE = 'Database report';
export const TEMPLATE_END = 'Database report end';
export const SUBSCRIPTIONS_CATEGORY = 'SDZeroBot database report subscriptions';
export const QUERY_TIMEOUT = 600;
export const MAX_SUBPAGES = 20;
export const FAKE_INPUT_FILE = 'fake-configs.wikitext';
export const FAKE_OUTPUT_FILE = 'fake-output.wikitext';

const db = new enwikidb({
	connectionLimit: 10
});

export async function fetchQueries(): Promise<Record<string, Query[]>> {
	if (argv.fake) {
		let text = readFile(FAKE_INPUT_FILE);
		return { 'Fake-Configs': getQueriesFromText(text, 'Fake-Configs') };
	}
	let allQueries: Record<string, Query[]> = {};
	let pages = (await new bot.page('Template:' + TEMPLATE).transclusions());
	for await (let pg of bot.readGen(pages)) {
		if (pg.ns === 0) { // sanity check: don't work in mainspace
			continue;
		}
		let text = pg.revisions[0].content;
		allQueries[pg.title] = getQueriesFromText(text, pg.title);
	}
	return allQueries;
}

function getQueriesFromText(text: string, title: string): Query[] {
	let templates = bot.wikitext.parseTemplates(text, {
		namePredicate: name => name === TEMPLATE
	});
	if (templates.length === 0) {
		log(`[E] Failed to parse template on ${title}`);
		return [];
	}
	return templates.map(template => new Query(template, title));
}

let lastEditsData: Record<string, MwnDate>;

// Called from the cronjob
export async function processQueries(allQueries: Record<string, Query[]>) {
	await db.getReplagHours();
	// Get the date of the bot's last edit to each of the subscribed pages
	// The API doesn't have an efficient query for this, so using the DB instead
	let startTime = process.hrtime.bigint();
	let lastEditsDb = await db.query(`
		SELECT page_namespace, page_title,
			(SELECT MAX(rc_timestamp) FROM recentchanges_userindex
			 JOIN actor_recentchanges ON rc_actor = actor_id AND actor_name = ?
			 WHERE rc_namespace = page_namespace AND rc_title = page_title
			) AS last_edit
		FROM page 
		JOIN categorylinks ON cl_from = page_id AND cl_to = ?
	`, [BOT_NAME, SUBSCRIPTIONS_CATEGORY].map(e => e.replace(/ /g, '_')));
	let endTime = process.hrtime.bigint();
	log(`[i] Retrieved last edits data. DB query took ${parseInt(String(endTime - startTime))/1e9} seconds.`);

	lastEditsData = Object.fromEntries(lastEditsDb.map((row) => [
		new bot.page(row.page_title as string, row.page_namespace as number).toText(),
		row.last_edit && new bot.date(row.last_edit)
	]));

	await bot.batchOperation(Object.entries(allQueries), async ([page, queries]) => {
		log(`[+] Processing page ${page}`);
		await processQueriesForPage(queries);
	}, 10);
}

export async function fetchQueriesForPage(page: string): Promise<Query[]> {
	let text = (await bot.read(page))?.revisions?.[0]?.content;
	if (!text) {
		return null;
	}
	return getQueriesFromText(text, page);
}

// All queries are on same page. Processing is done sequentially
// to avoid edit-conflicting with self.
export async function processQueriesForPage(queries: Query[]) {
	let index = 0;
	for (let query of queries) {
		if (++index !== 1) log(`[+] Processing query ${index} on ${query.page}`);
		await query.process().catch(() => {});
	}
}

export class Query {

	/// Step 1. Parse the query
	/// Step 2. Run the query
	/// Step 3. Format the result
	/// Step 4. Save the page

	page: string;
	template: Template;
	sql: string;
	wikilinkConfig: Array<{columnIndex: number, namespace: string, showNamespace: boolean}>;
	excerptConfig: Array<{srcIndex: number, destIndex: number, namespace: string, charLimit: number, charHardLimit: number}>;
	commentConfig: number[];
	warnings: string[] = [];
	pagination: number;
	maxPages: number;
	numPages: number;
	hiddenColumns: number[];

	constructor(template: Template, page: string) {
		this.page = page;
		this.template = template;
	}

	async process() {
		try {
			this.parseQuery();
			const result = await this.runQuery();
			const resultText = await this.formatResults(result);
			await this.save(resultText);
		} catch (err) {
			if (err instanceof HandledError) return;
			emailOnError(err, 'quarry2wp');
			throw err; // propagate error
		}
	}

	getTemplateValue(param: string) {
		return this.template.getValue(param)?.replace(/<!--.*?-->/g, '').trim();
	}

	static checkIfUpdateDue(lastUpdate: MwnDate, frequency: number): boolean {
		if (!lastUpdate) {
			return true;
		}
		let daysDiff = (new bot.date().getTime() - lastUpdate.getTime())/8.64e7;
		return daysDiff >= frequency - 0.5;
	}

	parseQuery() {
		if (process.env.CRON) {
			if (this.getTemplateValue('autoupdate')?.toLowerCase() === 'no') {
				log(`[+] Skipping ${this.page} as automatic updates are disabled.`);
				throw new HandledError();
			}
			let frequency = parseInt(this.getTemplateValue('frequency'));
			if (isNaN(frequency)) {
				frequency = 1;
			}
			if (!Query.checkIfUpdateDue(lastEditsData[this.page], frequency)) {
				log(`[+] Skipping ${this.page} as update is not due.`);
				throw new HandledError();
			}
		}

		// remove semicolons to disallow multiple SQL statements used together
		this.sql = this.getTemplateValue('sql').replace(/;/g, '');

		this.wikilinkConfig = this.getTemplateValue('wikilinks')
			?.split(',')
			.map(e => {
				const [columnIndex, namespace, showHide] = e.trim().split(':');
				return {
					columnIndex: parseInt(columnIndex),
					namespace: namespace || '0',
					showNamespace: showHide === 'show'
				};
			})
			.filter(config => {
				if (!/^c?\d+/i.test(config.namespace)) {
					this.warnings.push(`Invalid namespace number: ${config.namespace}. Refer to [[WP:NS]] for namespace numbers`);
					return false;
				} else if (isNaN(config.columnIndex)) {
					this.warnings.push(`Invalid column number: ${config.columnIndex}.`);
					return false;
				}
				return true;
			}) || [];

		this.commentConfig = this.getTemplateValue('comments')
			?.split(',')
			.map(e => parseInt(e.trim()) + 1)
			.filter(e => !isNaN(e))|| [];

		this.excerptConfig = this.getTemplateValue('excerpts')
			?.split(',')
			.map(e => {
				const [srcIndex, destIndex, namespace, charLimit, charHardLimit] = e.trim().split(':');
				const config = {
					srcIndex: parseInt(srcIndex),
					destIndex: destIndex ? parseInt(destIndex) : parseInt(srcIndex) + 1,
					namespace: namespace || '0',
					charLimit: charLimit ? parseInt(charLimit) : 250,
					charHardLimit: charHardLimit ? parseInt(charHardLimit) : 500
				};
				if (
					isNaN(config.srcIndex) || isNaN(config.destIndex) || !/^c?\d+/i.test(config.namespace) ||
					isNaN(config.charLimit) || isNaN(config.charHardLimit)
				) {
					this.warnings.push(`Invalid excerpt config: one or more numeral values found in: <code>${e}</code>. Ignoring.`);
					return null;
				} else {
					return config;
				}
			})
			.filter(e => e) // filter out nulls
			|| [];

		this.hiddenColumns = this.getTemplateValue('hide')
			?.split(',')
			.map(e => parseInt(e.trim()) + 1)
			.filter(e => !isNaN(e)) || [];

		this.pagination = this.getTemplateValue('pagination')
			? parseInt(this.getTemplateValue('pagination'))
			: Infinity;
		if (isNaN(this.pagination)) {
			this.warnings.push(`Non-numeral value "${this.getTemplateValue('pagination')}" specified for pagination. Ignored.`);
			this.pagination = Infinity;
		}
		this.maxPages = Math.min(MAX_SUBPAGES,
			this.getTemplateValue('max_pages') ? parseInt(this.getTemplateValue('max_pages')) : 5
		);

	}

	async runQuery() {
		let query = `SET STATEMENT max_statement_time = ${QUERY_TIMEOUT} FOR ${this.sql.trim()}`;
		return db.query(query).catch(async (err: SQLError) => {
			if (err.sqlMessage) {
				// SQL server error
				let message = `SQL Error: ${err.code || ''}: ${err.sqlMessage}`;
				if (err.errno === 1969) {
					// max_statement_time exceeded
					message += ` - ${BOT_NAME} applies a timeout of ${QUERY_TIMEOUT} seconds on all queries.`;
				} else if (err.errno === 1040) {
					// too many connections (should not happen)
					log(`[E] Too Many Connections Error!`);
					throw err;
				} else {
					message += ` – Consider using [https://quarry.wmflabs.org/ Quarry] to to test your SQL.`;
				}
				return this.saveWithError(message);
			} else {
				throw err;
			}
		});
	}

	transformColumn(result: Array<Record<string, string>>, columnIdx: number, transformer: (cell: string, rowIdx: number) => string): Array<Record<string, string>> {
		return result.map((row, rowIdx) => {
			return Object.fromEntries(Object.entries(row).map(([key, value], colIdx) => {
				if (columnIdx === colIdx + 1) {
					return [key, transformer(value, rowIdx)];
				} else {
					return [key, value];
				}
			}));
		});
	}

	/**
	 * Add column at given `columnIdx`. Move existing columns at columnIdx and later one place rightwards.
	 */
	addColumn(result: Array<Record<string, string>>, columnIdx: number, contents: string[]): Array<Record<string, string>> {
		return result.map((row, idx) => {
			let newRow = Object.entries(row);
			newRow.splice(columnIdx - 1, 0, ['Excerpt', contents[idx]]);
			return Object.fromEntries(newRow);
		});
	}

	removeColumn(result: Array<Record<string, string>>, columnIdx: number): Array<Record<string, string>> {
		return result.map((row, idx) => {
			let newRow = Object.entries(row);
			newRow.splice(columnIdx - 1, 1);
			return Object.fromEntries(newRow);
		});
	}

	async fetchExcerpts(pages: string[], charLimit: number, charHardLimit: number): Promise<string[]> {
		let excerpts: Record<string, string> = {};
		for (let pageSet of arrayChunk(pages, 100)) {
			for await (let pg of bot.readGen(pageSet, {
				rvsection: 0,
				redirects: false
			})) {
				if (pg.invalid || pg.missing) {
					excerpts[pg.title] = '';
				} else {
					excerpts[pg.title] = TextExtractor.getExtract(pg.revisions[0].content, charLimit, charHardLimit);
				}
			}
		}
		// Order of pages in API output will be different from the order we have
		return pages.map(pg => {
			// XXX: will page name in pages array always match pg.title from API?
			if (excerpts[pg] !== undefined) {
				return '<small>' + excerpts[pg] + '</small>';
			} else {
				log(`[W] no excerpt found for ${pg} while processing query on ${this.page}`);
				return '';
			}
		});
	}

	async formatResults(result) {

		if (result.length === 0) {
			return 'No items retrieved.'; // XXX
		}
		if (result.length > this.pagination) {
			const resultSets = arrayChunk(result, this.pagination).slice(0, this.maxPages);
			this.numPages = resultSets.length;
			const resultTexts: string[] = [];
			let pageNumber = 1;
			for (let resultSet of resultSets) {
				resultTexts.push(await this.formatResultSet(resultSet, pageNumber++));
			}
			return resultTexts;
		} else {
			this.numPages = 1;
			return this.formatResultSet(result, 0);
		}
	}

	async formatResultSet(result, pageNumber: number) {

		let table = new mwn.table({
			style: this.getTemplateValue('table_style') || 'overflow-wrap: anywhere'
		});

		let numColumns = Object.keys(result[0]).length;
		for (let i = 1; i <= numColumns; i++) {
			// Stringify everything
			result = this.transformColumn(result, i, (value: string | number | null | Date) => {
				if (value === null) return '';
				if (value instanceof Date) return value.toISOString();
				return String(value);
			});
		}

		// Add excerpts
		for (let {srcIndex, destIndex, namespace, charLimit, charHardLimit} of this.excerptConfig) {
			result = this.transformColumn(result, srcIndex, pageName => pageName.replace(/_/g, ' '));
			let nsId, nsColNumber;
			if (!isNaN(parseInt(namespace))) {
				nsId = parseInt(namespace);
			} else {
				nsColNumber = parseInt(namespace.slice(1)) - 1;
			}
			const listOfPages = result.map((row) => {
				try {
					let cells = Object.values(row);
					return new bot.page(
						cells[srcIndex - 1] as string,
						nsId ?? Number(cells[nsColNumber])
					).toText();
				} catch (e) { return '::'; } // new bot.page() failing, use invalid page name so that
				// fetchExcerpts returns empty string extract
			});
			const excerpts = await this.fetchExcerpts(listOfPages, charLimit, charHardLimit);
			result = this.addColumn(result, destIndex, excerpts);
		}

		// Number of columns increased due to excerpts
		numColumns += this.excerptConfig.length;

		// Add links
		this.wikilinkConfig.forEach(({columnIndex, namespace, showNamespace}) => {
			let nsId, nsColNumber;
			if (!isNaN(parseInt(namespace))) {
				nsId = parseInt(namespace);
			} else {
				nsColNumber = parseInt(namespace.slice(1)) - 1;
			}
			result = this.transformColumn(result, columnIndex, (value, rowIdx) => {
				try {
					let title = new bot.title(value, nsId ?? Number(Object.values(result[rowIdx])[nsColNumber]));
					// title.getNamespaceId() need not be same as namespace passed to new bot.title
					let colon = [NS_CATEGORY, NS_FILE].includes(title.getNamespaceId()) ? ':' : '';
					let pageName = title.toText();
					return showNamespace ? `[[${colon}${pageName}]]` : `[[${colon}${pageName}|${value.replace(/_/g, ' ')}]]`;
				} catch (e) {
					return value.replace(/_/g, ' ');
				}
			});
		});

		// Format edit summaries / log action summaries
		this.commentConfig.forEach(columnIndex => {
			result = this.transformColumn(result, columnIndex, (value) => {
				return formatSummary(value);
			});
		});

		this.getTemplateValue('remove_underscores')?.split(',').forEach(num => {
			let columnIndex = parseInt(num.trim());
			if (isNaN(columnIndex)) {
				this.warnings.push(`Found non-numeral value in <code>remove_underscores</code>: "${num}". Ignoring. Please use a comma-separated list of column numbers`);
			} else if (columnIndex > numColumns) {
				this.warnings.push(`Found "${num}" in <code>remove_underscores</code> though the table only has ${numColumns} column{{subst:plural:${numColumns}||s}}. Ignoring.`);
			} else {
				result = this.transformColumn(result, columnIndex, value => value.replace(/_/g, ' '));
			}
		});

		let widths = this.getTemplateValue('widths')?.split(',').map(e => {
			let [colIdx, width] = e.split(':');
			return {
				column: parseInt(colIdx),
				width: width
			};
		});

		// Last step: changes column numbers
		this.hiddenColumns.sort().forEach((columnIdx, idx) => {
			// columnIdx - idx because column numebering changes when one is removed
			result = this.removeColumn(result, columnIdx - idx);
		});

		table.addHeaders(Object.keys(result[0]).map((columnName, columnIndex) => {
			let columnConfig: {label: string, style?: string} = {
				label: columnName,
			};
			let width = widths?.find(e => e.column === columnIndex + 1)?.width;
			if (width) {
				columnConfig.style = `width: ${width}`;
			}
			return columnConfig;
		}));

		for (let row of result) {
			table.addRow(Object.values(row));
		}

		// Get DB replag, but no need to do this any more than once in 6 hours (when triggered via
		// webservice or eventstream-router).
		if (
			db.replagHours === undefined ||
			db.replagHoursCalculatedTime.isBefore(new bot.date().subtract(6, 'hours'))
		) {
			await db.getReplagHours();
		}

		let warningsText = this.warnings.map(text => `[WARN: ${text}]\n\n`).join('');

		return (pageNumber <= 1 ? warningsText : '') +
			db.makeReplagMessage(2) +
			TextExtractor.finalSanitise(table.getText()) + '\n' +
			'----\n' +
			mwn.template('Database report/footer', {
				count: result.length,
				page: pageNumber && String(pageNumber),
				num_pages: pageNumber && String(this.numPages)
			});
	}

	async save(queryResult: string | string[], isError = false) {
		if (argv.fake) {
			writeFile(
				FAKE_OUTPUT_FILE,
				this.insertResultIntoPageText(
					readFile(FAKE_OUTPUT_FILE) || readFile(FAKE_INPUT_FILE),
					queryResult as string
				)
			);
			return;
		}
		let page = new bot.page(this.page);
		let firstPageResult = Array.isArray(queryResult) ? queryResult[0] : queryResult;
		try {
			await page.edit(rev => {
				let text = rev.content;
				let newText = this.insertResultIntoPageText(text, firstPageResult);
				return {
					text: newText,
					summary: isError ? 'Encountered error in database report update' : 'Updating database report'
				};
			});
		} catch (err) {
			if (isError) { // error on an error logging attempt, just throw now
				throw err;
			}
			// In case of errors like `contenttoobig` we can still edit the page
			// to add the error message, but not in case of errors like protectedpage
			log(`[E] Couldn't save to ${this.page} due to error ${err.code}`);
			log(err);
			if (err.code === 'protectedpage') {
				throw err;
			}
			return this.saveWithError(`Error while saving report: ${err.message}`);
		}
		if (Array.isArray(queryResult)) {
			for (let [idx, resultText] of Object.entries(queryResult)) {
				let pageNumber = parseInt(idx) + 1;
				if (pageNumber ===  1) continue; // already saved above
				let subpage = new bot.page(this.page + '/' + pageNumber);
				await subpage.save(
					`{{Database report/subpage|page=${pageNumber}|num_pages=${this.numPages}}}\n` +
					resultText,
					'Updating database report'
				);
			}
			for (let i = this.numPages + 1; i <= MAX_SUBPAGES; i++) {
				let subpage = new bot.page(this.page + '/' + i);
				let apiPage = await bot.read(subpage.toText());
				if (apiPage.missing) {
					break;
				}
				await subpage.save(
					`{{Database report/subpage|page=${i}|num_pages=${this.numPages}}}\n` +
					`{{Database report/footer|count=0|page=${i}|num_pages=${this.numPages}}}`,
					'Updating database report subpage - empty'
				);
			}
		}
	}

	async saveWithError(message: string) {
		await this.save(`{{error|[${message}]}}`, true);
		throw new HandledError();
	}

	insertResultIntoPageText(text: string, queryResult: string) {
		// Does not support the case of two template usages with very same wikitext
		let beginTemplateStartIdx = text.indexOf(this.template.wikitext);
		if (beginTemplateStartIdx === -1) {
			throw new Error(`Failed to find template in wikitext on page ${this.page}`);
		}
		let beginTemplateEndIdx = beginTemplateStartIdx + this.template.wikitext.length;
		let endTemplateStartIdx = text.indexOf(`{{${TEMPLATE_END}}}`, beginTemplateEndIdx);
		if (endTemplateStartIdx === -1) { // caps, XXX
			endTemplateStartIdx = text.indexOf(`{{${lowerFirst(TEMPLATE_END)}}}`, beginTemplateEndIdx);
		}
		let textToReplace = text.slice(
			beginTemplateEndIdx,
			endTemplateStartIdx === -1 ? undefined : endTemplateStartIdx
		);
		return text.slice(0, beginTemplateEndIdx) +
			text.slice(beginTemplateEndIdx).replace(textToReplace, '\n' + queryResult.replace(/\$/g, '$$$$') + '\n');
	}
}

// hacky way to prevent further execution in process(), but not actually report as error
class HandledError extends Error {}
