import type { Product } from '../types';

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function ProductCard({ product }: { product: Product }) {
  return (
    <article className="card">
      <img className="card-img" src={product.imageUrl} alt={product.name} loading="lazy" />
      <div className="card-body">
        <h2>{product.name}</h2>
        <p className="price">{money.format(product.price)}</p>
        <p className="desc">{product.description}</p>
      </div>
    </article>
  );
}
