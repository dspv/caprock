// The local junk filter's reasons, as internal/mail/spam names them
// (junk_why: rule codes, strongest first), in words for the reader.
const REASONS: Record<string, string> = {
  'provider-spam': 'your mail server marked it as spam',
  'provider-score': 'your mail server scored it as spam',
  'provider-score-high': 'your mail server found it suspicious',
  'dmarc-fail': 'the sender’s domain does not vouch for it (DMARC)',
  'spf-fail': 'it came from a server the domain does not allow (SPF)',
  'spf-softfail': 'the domain is unsure of the sending server (SPF)',
  'dkim-fail': 'its signature does not match (DKIM)',
  unauthenticated: 'nothing proves who sent it',
  'brand-spoof': 'the name is a brand, the address is not theirs',
  'name-has-other-address': 'the name shows a different address',
  'cheap-tld': 'it comes from a domain type used mostly by spam',
  'reply-to-freemail': 'replies would go to a free mail address',
  'reply-to-elsewhere': 'replies would go to another domain',
  'fake-reply': '“Re:” on a conversation that never happened',
  'subject-caps': 'a shouting subject',
  'subject-punct': 'a subject full of !!! or $$$',
  'no-message-id': 'no message ID',
  'url-shortener': 'links hidden behind a URL shortener',
  'deceptive-link': 'a link shows one site and goes to another',
  'image-only': 'almost all image, hardly any text',
  'link-only': 'a link and hardly any text',
  learned: 'it looks like mail you marked as spam',
}

/** Up to three reasons, in words: "your mail server marked it as spam, …". */
export function junkReasons(why?: string): string {
  const out = (why ?? '').split(',').map((c) => REASONS[c.trim()]).filter((x): x is string => !!x)
  return out.slice(0, 3).join(', ')
}
