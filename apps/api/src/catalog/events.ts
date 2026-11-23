/**
 * Catalog events (Phase 12). Only a NOTIFICATION ("product X changed"), not the product itself: the indexer reads the
 * latest row from MySQL when it handles one. Duplicates and events arriving out of order then can't leave an old
 * version in the search copy, and a deleted product is simply removed.
 */
export const PRODUCT_CHANGED = 'product.changed';

export interface ProductChangedEvent {
  productId: number;
}
