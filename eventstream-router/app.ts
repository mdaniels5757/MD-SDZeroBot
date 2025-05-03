import {argv, bot, emailOnError, fs, log} from "../botbase";
import {RecentChangeStreamEvent} from "./RecentChangeStreamEvent";
import {createLogStream, stringifyObject} from "../utils";
import EventSource = require("./EventSource");
import {MINUTE, SECOND} from "../millis";

// TODO: improve logging

/**
 * REGISTER ROUTES
 *
 * A route should default export a class extending Route, which defines the
 * filter and worker methods. The worker should be idempotent, that is, it
 * must handle the scenario of the same event being passed to it multiple times,
 * which could occur due to reconnections.
 *
 * NOTE: Route files should NOT contain any process.chdir() statements!
 * Avoid executing code at the top level, put any required initializations
 * in the class init() method, which can be async.
 *
 */
export abstract class Route {
	readonly abstract name: string;
	log: ((...msg: any[]) => void);

	// TODO: init timeout to avoid overflow of memory (while buffering events waiting for init)
	init(): void | Promise<void> {
		this.log = createLogStream('./' + this.name + '.out');
	}

	filter(data: RecentChangeStreamEvent): boolean {
		return true;
	}

	abstract worker(data: RecentChangeStreamEvent);
}

export class RouteValidator {
	name: string;
	worker: ((data: RecentChangeStreamEvent) => any);
	filter: ((data: RecentChangeStreamEvent) => boolean);
	init: (() => any);
	isValid: boolean;
	ready: Promise<void>;

	validate(routeCls: new () => Route) {
		let route = new routeCls();
		this.name = route.name;
		this.worker = route.worker.bind(route);
		this.filter = route.filter.bind(route);
		this.init = route.init.bind(route);

		if (!route.name) {
			log(`[E] Found task without a name. Please define name property in all route classes.`)
		}
		if (typeof this.filter !== 'function' || typeof this.worker !== 'function') {
			log(`[E] Invalid route ${route.name}: filter or worker is not a function`);
			this.isValid = false;
			return;
		}
		this.ready = new Promise((resolve, reject) => {
			if (typeof this.init !== 'function') {
				resolve();
				log(`[V] Initialized ${route.name} with no initializer`);
			} else {
				Promise.resolve(this.init()).then(() => {
					resolve();
					log(`[V] Initialized ${route.name}`);
				}, (err) => {
					reject();
					logError(err, route.name);
				});
			}
		});
		this.isValid = true;
		return this;
	}
}

// XXX: consider using Redis rather than NFS since this does a write every 1 second
class LastSeen {

	ts: number;

	// File where last seen timestamp is stored
	file: string;

	// Number of milliseconds after which lastSeenTs is to be saved to file
	updateInterval: number;

	constructor(filePath: string, updateInterval: number) {
		this.file = filePath;
		this.updateInterval = updateInterval;
		setInterval(() => this.write(), this.updateInterval);
	}

	read() {
		try {
			return parseInt(fs.readFileSync(this.file).toString());
		} catch (e) {
			return NaN;
		}
	}

	write() {
		fs.writeFile(this.file, String(this.ts), err => err && console.log(err));
	}

	get() {
		return new bot.Date(
			((typeof this.ts === 'number') ? this.ts : this.read())
			* 1000
		);
	}
}

let routerLog;

function addToRouterLog(routeName: string, data: RecentChangeStreamEvent) {
	let catNote = '';
	if (data.type === 'categorize') {
		let page = pageFromCategoryEvent(data);
		if (page) {
			catNote = (page.added ? '+' : '–') + page.title + '@';
		}
	}
	routerLog(`Routing to ${routeName}: ${catNote}${data.title}@${data.wiki}`);
}

let stream;

function run(routes: RouteValidator[], lastSeen: LastSeen) {
	log('[S] Restarted');

	const ts = lastSeen.get();
	const tsUsable = ts.isValid() && new bot.Date().subtract(7, 'days').isBefore(ts);
	log(`[i] lastSeenTs: ${ts}: ${tsUsable}`);

	let since = !argv.fromNow && tsUsable ? ts : new bot.Date();

	if (stream) {
		// ensure that there aren't two parallel connections
		stream.close();
	}
	stream = new EventSource(
		`https://stream.wikimedia.org/v2/stream/recentchange?since=${since.toISOString()}`, {
			headers: {
				'User-Agent': bot.options.userAgent
			}
		});

	stream.onopen = function () {
		// EventStreams API drops connection every 15 minutes ([[phab:T242767]])
		// So this will be invoked every time that happens.
		log(`[i] Reconnected`);
	}

	stream.onerror = function (evt) {
		if (evt.type === 'error' && evt.message === undefined) {
			// The every 15 minute connection drop?
			return; // EventSource automatically reconnects. No unnecessary logging.
			// TODO: consider logging this, if this is the source of other kinds of drops as well
		}
		log(`[W] Event source encountered error:`);
		logError(evt);

		if (evt.status === 429) { // Too Many Requests, the underlying library doesn't reconnect by itself
			bot.sleep(5 * SECOND).then(() => {
				start(routes, lastSeen); // restart
			});
		}
		// TODO: handle other errors, ensure auto-reconnection
	}

	stream.onmessage = function (event) {
		let data: RecentChangeStreamEvent = JSON.parse(event.data);
		if (data.meta.domain === 'canary') {
			// Ignore canary events, https://phabricator.wikimedia.org/T266798
			return;
		}
		lastSeen.ts = data.timestamp;
		for (let route of routes) {
			// the filter method is only invoked after the init(), so that init()
			// can change the filter function
			route.ready.then(() => {
				try {
					if (route.filter(data)) {
						addToRouterLog(route.name, data);
						route.worker(data);
					}
				} catch (e) {
					logError(e, route.name);
				}
			});
		}
	}
}

function start(routes: RouteValidator[], lastSeen: LastSeen) {
	try {
		run(routes, lastSeen);
	} catch (err) { // should never occur
		emailOnError(err, 'stream (run)');
	}
}

interface StreamAppConfig {
	routingLogFile?: string;
	lastSeenFile?: string;
	lastSeenUpdateInterval?: number;
	healthCheckInterval?: number;
}

export async function streamWithRoutes(routes: (new () => Route)[], config: StreamAppConfig = {}) {
	// XXX: for some routes like dyk-counts, enabling retries can cause stale data to be saved after retry sleeps
	bot.setOptions({ maxRetries: 0, defaultParams: { maxlag: undefined } });
	await bot.getTokensAndSiteInfo();
	setInterval(function () {
		bot.getTokens();
	}, 10 * MINUTE);

	let validatedRoutes = routes.map(routeCls => {
		return new RouteValidator().validate(routeCls);
	}).filter(route => {
		return route.isValid;
	});
	routerLog = createLogStream(config.routingLogFile || './routerlog.out');
	const lastSeen = new LastSeen(
		config.lastSeenFile || './last-seen.txt',
		config.lastSeenUpdateInterval || SECOND
	);
	start(validatedRoutes, lastSeen);

	setInterval(() => {
		if (lastSeen.get().add(2, 'minutes').isBefore(new Date())) {
			log(`[E] Restarting as no events seen in last two minutes`);
			start(validatedRoutes, lastSeen);
		}
	}, config.healthCheckInterval || 2 * MINUTE);

}

export function logError(err, task?) {
	let taskFmt = task ? `[${task}]` : '';
	let stringified;
	if (err.stack) {
		log(`${taskFmt} ${err.stack}`);
	} else if (stringified = stringifyObject(err)) {
		log(`${taskFmt} ${stringified}`);
	} else {
		log(`${taskFmt}`);
		console.log(err);
	}
}

export function pageFromCategoryEvent(data: RecentChangeStreamEvent) {
	let match = /^\[\[:(.*?)\]\] (added|removed)/.exec(data.comment);
	if (!match) {
		return null;
	}
	return {
		title: match[1],
		added: match[2] === 'added',
		removed: match[2] === 'removed'
	};
}
