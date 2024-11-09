import {bot} from './botbase';

export default class TextExtractor {

	/**
	 * Get wikitext extract. If you want plain text or HTML extracts, consider using
	 * the TextExtracts API instead.
	 * @param pagetext - full page text
	 * @param [charLimit] - cut off the extract at this many readable characters, or wherever
	 * the sentence ends after this limit
	 * @param [hardUpperLimit] - cut off the extract at this many readable characters even if
	 * the sentence hasn't ended
	 * @param [preprocessHook] - optional function to work on the text at the
	 * beginning
	 */
	static getExtract(pagetext: string, charLimit?: number, hardUpperLimit?: number, preprocessHook?: ((text: string) => string)) {

		if (!pagetext) {
			return '';
		}
		let extract = pagetext;

		if (preprocessHook) {
			extract = preprocessHook(extract);
		}

		// Remove images. Can't be done correctly with just regex as there could be wikilinks
		// in the captions.
		extract = this.removeImages(extract);

		// Remove templates beginning on a new line, such as infoboxes.
		// These occasionally contain parameters with part of the content
		// beginning on a newline not starting with a | or * or # or !
		// thus can't be handled with the line regex.
		extract = this.removeTemplatesOnNewlines(extract);

		// Remove some other templates too
		// Matches r, efn, refn, sfn, sfnm, sfnp, harv, harvp, audio, and IPA.* family
		extract = this.removeTemplates(extract, /^(r|sfn[bmp]?|harvp?|r?efn|respell|IPA.*|audio)$/i);

		extract = extract
			.replace(/<!--.*?-->/sg, '')
			// remove refs, including named ref definitions and named ref invocations
			.replace(/<ref.*?(?:\/>|<\/ref>)/sgi, '')
			// the magic
			.replace(/^\s*[-{|}=*#:<!].*$/mg, '')
			// trim left to prepare for next step
			.trimLeft()
			// keep only the first paragraph
			.replace(/\n\n.*/s, '')
			// remove single newlines - they cause paragraph breaks only in tables
			.replace(/ ?\n/g, ' ')
			// unbold
			.replace(/'''(.*?)'''/g, '$1')
			// cleanup side-effects from removing IPA/audio templates
			.replace(/\((?:\s*[,;])+\s*/g, '(')
			.replace(/ ?\(\s*\)/g, '')
			.trim();

		if (charLimit) {
			// We consider a period followed by a space or newline NOT followed by a lowercase char
			// as a sentence ending. Lowercase chars after period+space is generally use of an abbreviation
			// XXX: this still results in issues with name like Arthur A. Kempod.
			//  (?![^[]*?\]\]) so that this is not a period within a link
			//  (?![^{*]?\}\}) so that this is not a period within a template - doesn't work if there
			//      is a nested templates after the period.
			const sentenceEnd = /\.\s(?![a-z])(?![^[]*?\]\])(?![^{]*?\}\})/g;

			if (extract.length > charLimit) {
				let match = sentenceEnd.exec(extract);
				while (match) {
					if (this.effCharCount(extract.slice(0, match.index)) > charLimit) {
						extract = extract.slice(0, match.index + 1);
						break;
					} else {
						match = sentenceEnd.exec(extract);
					}
				}
			}
		}

		if (hardUpperLimit) {
			if (this.effCharCount(extract) > hardUpperLimit) {
				extract = extract.slice(0, hardUpperLimit) + ' ...';
			}
		}

		return extract;
	}

	static removeImages(text: string) {
		let wkt = new bot.wikitext(text);
		wkt.parseLinks();
		wkt.files.forEach(file => {
			wkt.removeEntity(file);
		});
		return wkt.getText();
	}

	static removeTemplatesOnNewlines(text: string) {
		let templateOnNewline = /^\{\{/m; // g is omitted for a reason, the text is changing.
		let match = templateOnNewline.exec(text);
		while (match) {
			let template = new bot.wikitext(text.slice(match.index)).parseTemplates({count: 1})[0];
			if (template) {
				text = text.replace(template.wikitext, '');
			} else { // just get rid of that line, otherwise we'd enter an infinite loop
				text = text.replace(/^\{\{.*$/m, '');
			}
			match = templateOnNewline.exec(text);
		}
		return text;
	}

	static removeTemplates(text: string, templateNameRegex: RegExp) {
		let wkt = new bot.wikitext(text);
		wkt.parseTemplates({
			namePredicate: name => templateNameRegex.test(name)
		});
		for (let template of wkt.templates) {
			wkt.removeEntity(template);
		}
		return wkt.getText();
	}

	static effCharCount(text: string) {
		return text
			.replace(/\[\[:?(?:[^|\]]+?\|)?([^\]|]+?)\]\]/g, '$1')
			.replace(/''/g, '')
			.length;
	}


	/**
	 * Do away with some of the more bizarre stuff from page extracts that aren't worth
	 * checking for on a per-page basis
	 * Minimise the amount of removals done here, since if the extract was cut off, it may
	 * happen one of the regexes below will match across two different extracts.
	 * @param {string} content
	 */
	static finalSanitise(content: string) {
		return content.replace(/\[\[Category:.*?\]\]/gi, '')
			// these are just bad
			.replace(/__[A-Z]+__/g, '')
			// Openings of any unclosed ref tags
			.replace(/<ref[^<]*?(>|(?=\n))/gi, '')
			// remove categories added via {{post-nomials}}
			.replace(/(\|country=[A-Z]{3})-cats/g, '$1');
	}
}
