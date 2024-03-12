import * as express from "express";
import { enwikidb } from "../../../SDZeroBot/db";

const router = express.Router();
const db = new enwikidb();

// TODO: Fix up redis caching, last present in f541de61

router.get('/credits/:user', async (req, res, next) => {
	const user = req.params.user.replace(/ /g, '_');
	const result = await db.query(`
		SELECT COUNT(*) AS count FROM revision_userindex
		JOIN page ON rev_page = page_id
		JOIN actor_revision ON rev_actor = actor_id
		WHERE page_namespace = 3
		AND actor_name = 'DYKUpdateBot'
		AND SUBSTRING_INDEX(page_title, '/', 1) = ?
	`, [user]);
	const count = result[0].count;
	res.end(String(count));
});

router.get('/noms/:user', async (req, res, next) => {
	const user = req.params.user.replace(/ /g, '_');
	const result = await db.query(`
		SELECT COUNT(*) AS count FROM revision_userindex
		JOIN page ON rev_page = page_id
		JOIN actor_revision ON rev_actor = actor_id
		WHERE page_namespace = 10
		AND page_is_redirect = 0
		AND rev_parent_id = 0
		AND page_title LIKE 'Did_you_know_nominations/%'
		AND actor_name = ?
	`, [user]);
	const count = result[0].count;
	res.end(String(count));
});

export default router;
