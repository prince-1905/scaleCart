import { toBooleanQuery } from './search-query.js';

describe('toBooleanQuery', () => {
  it('requires every word and allows prefixes', () => {
    expect(toBooleanQuery('Red Sho')).toBe('+red* +sho*');
  });

  it('strips boolean operators so users cannot inject query syntax', () => {
    expect(toBooleanQuery('-cotton +"wool" (silk)* ~x @2')).toBe('+cotton* +wool* +silk*');
  });

  it('drops stopwords, short words and duplicates', () => {
    expect(toBooleanQuery('the a of jacket jacket')).toBe('+jacket*');
  });

  it('caps the number of terms', () => {
    expect(toBooleanQuery('one two six ten red blue green')).toBe('+one* +two* +six* +ten* +red*');
  });

  it('returns null when nothing searchable is left', () => {
    expect(toBooleanQuery('  a ++ the ')).toBeNull();
  });

  it('keeps non-English letters', () => {
    expect(toBooleanQuery('café jäger')).toBe('+café* +jäger*');
  });
});
