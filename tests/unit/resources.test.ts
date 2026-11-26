import { describe, expect, it } from 'vitest';
import {
  SUPPORTED_SCOPES,
  authorizationServerMetadata,
  normalizeResource,
  resourceUrls,
} from '../../src/auth/resources.js';

describe('resourceUrls', () => {
  it('maps the aggregate and every account path to a resource on the public origin', () => {
    const urls = resourceUrls(new URL('http://127.0.0.1:8787'), ['a']);
    expect([...urls]).toEqual([
      ['/mcp', 'http://127.0.0.1:8787/mcp'],
      ['/mcp/a', 'http://127.0.0.1:8787/mcp/a'],
    ]);
  });

  it('uses the public origin even when the URL object carries a trailing slash path', () => {
    const urls = resourceUrls(new URL('https://mail.example/'), ['work', 'home']);
    expect(urls.get('/mcp')).toBe('https://mail.example/mcp');
    expect(urls.get('/mcp/work')).toBe('https://mail.example/mcp/work');
    expect(urls.get('/mcp/home')).toBe('https://mail.example/mcp/home');
  });
});

describe('authorizationServerMetadata', () => {
  it('describes exactly the supported flow', () => {
    expect(authorizationServerMetadata(new URL('https://mail.example'))).toEqual({
      issuer: 'https://mail.example',
      authorization_endpoint: 'https://mail.example/authorize',
      token_endpoint: 'https://mail.example/token',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['offline_access'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  });

  it('lists the supported scopes constant', () => {
    expect(SUPPORTED_SCOPES).toEqual(['offline_access']);
  });
});

describe('normalizeResource', () => {
  it('drops one trailing slash', () => {
    expect(normalizeResource('https://x.example/mcp/')).toBe('https://x.example/mcp');
  });

  it('drops a fragment', () => {
    expect(normalizeResource('https://x.example/mcp/a#part')).toBe('https://x.example/mcp/a');
  });

  it('leaves a normal resource alone', () => {
    expect(normalizeResource('https://x.example/mcp/a')).toBe('https://x.example/mcp/a');
  });

  it('drops only one trailing slash', () => {
    expect(normalizeResource('https://x.example/mcp//')).toBe('https://x.example/mcp/');
  });
});
