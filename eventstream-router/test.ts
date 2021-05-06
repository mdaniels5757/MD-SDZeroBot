import {Route} from "./Route";

export default class Test extends Route {
	init() {
		super.init();
		this.log('[S] Started test route');
	}
	// filter(data): boolean {
	// 	return data.wiki === 'enwiki';
	// }

	worker(data) {
		this.log(data);
	}
}
