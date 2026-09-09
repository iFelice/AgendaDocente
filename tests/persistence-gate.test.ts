import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PersistenceGate } from '../src/components/PersistenceGate';

test('application and demo data are not rendered while persistence is loading',()=>{
  let rendered=false;
  const html=renderToStaticMarkup(React.createElement(PersistenceGate,{children:()=>{rendered=true;return 'DEMO DATA';}}));
  assert.equal(rendered,false);assert.match(html,/Caricamento dell’archivio locale/);assert.doesNotMatch(html,/DEMO DATA/);
});
