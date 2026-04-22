import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Surface } from './surface';

describe('Surface', () => {
  it('renders reusable premium surface classes without changing content', () => {
    const html = renderToStaticMarkup(
      <Surface as="section" glow="cyan" radius="hero" variant="active">
        Estado real
      </Surface>
    );

    expect(html).toContain('Estado real');
    expect(html).toContain('surface--active');
    expect(html).toContain('squircle-hero');
    expect(html).toContain('glow-cyan');
  });
});
