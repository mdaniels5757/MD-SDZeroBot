const {emailOnError} = require('../botbase');
const {exec, execSync} = require('child_process');

const testRgx = /\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] \[i\] Reconnected/;
const tail = execSync('tail -100 /data/project/sdzerobot/stream.out').toString();

let match; for (match of tail.matchAll(testRgx)) {} // now match is the last matched

let date = new Date(match[1]);
let currentDate = new Date();

let diff = currentDate.getTime() - date.getTime();

let minutesDiff = diff / 1000 / 60;

if (minutesDiff > 30) {
	let err = new Error('no recent entries. Restarting stream');
	err.stack = 'Last entry found: ' + match[0];
	emailOnError(err, 'stream');

	process.chdir(__dirname);
	exec("npm run restart", (error) => {
		if (error) {
			emailOnError(error, "stream-restart");
		}
	});
}
