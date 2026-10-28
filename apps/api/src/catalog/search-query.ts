/** InnoDB's default FULLTEXT stopwords: the index ignores them, so requiring one matches nothing. */
const STOPWORDS = new Set(
  'a about an are as at be by com de en for from how i in is it la of on or that the this to was what when where who will with und www'.split(
    ' ',
  ),
);

/** innodb_ft_min_token_size: shorter words are not in the index. */
const MIN_TERM_LENGTH = 3;
const MAX_TERMS = 5;

/**
 * Turns user input into a MySQL BOOLEAN MODE query where every word is required and
 * may be a prefix: "red sho" -> "+red* +sho*".
 *
 * Splitting on anything that isn't a letter or digit also strips the boolean
 * operators (+ - < > ( ) ~ * " @), so users can't inject query syntax.
 * Returns null when nothing searchable is left.
 */
export function toBooleanQuery(input: string): string | null {
  const terms = input
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= MIN_TERM_LENGTH && !STOPWORDS.has(t));
  const unique = [...new Set(terms)].slice(0, MAX_TERMS);
  return unique.length ? unique.map((t) => `+${t}*`).join(' ') : null;
}
