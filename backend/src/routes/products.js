import { Router } from 'express';
import { config } from '../config.js';
import { query } from '../db.js';

export const productsRouter = Router();

// The database stores only the S3 object key (e.g. "images/headphones.svg").
// The public URL is built here, so moving images to another bucket/CDN is a config change.
const toImageUrl = (key) => `${config.imageBaseUrl}/${key}`;

productsRouter.get('/', async (req, res, next) => {
  try {
    const [rows] = await query(
      'SELECT id, name, description, price, image_key FROM products ORDER BY id',
    );
    res.json({
      products: rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        price: r.price,
        imageUrl: toImageUrl(r.image_key),
      })),
    });
  } catch (err) {
    next(err);
  }
});
