import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AssemOrb } from './assem-orb';

describe('AssemOrb', () => {
  it('renders the shared ASSEM HUD identity with state classes', () => {
    const html = renderToStaticMarkup(<AssemOrb label="Escuchando" state="listening" />);

    expect(html).toContain('ASSEM');
    expect(html).toContain('assem-orb--listening');
    expect(html).toContain('Escuchando');
  });

  it('supports compact diagnostic usage for voice surfaces', () => {
    const html = renderToStaticMarkup(
      <AssemOrb diagnostic="Audio demasiado corto" label="Procesando" size="compact" state="processing" />
    );

    expect(html).toContain('assem-orb--compact');
    expect(html).toContain('Audio demasiado corto');
  });
});
