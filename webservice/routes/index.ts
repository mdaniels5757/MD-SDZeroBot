import * as express from "express";
const router = express.Router();

router.get('/', (req, res, next) => {
  res.render('webservice/views/index', { title: 'SDZeroBot' });
});

router.get('/ping', (req, res, next) => {
  res.send('pong');
});

export default router;
