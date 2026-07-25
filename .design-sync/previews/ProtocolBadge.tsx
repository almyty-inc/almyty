import { ProtocolBadge } from 'almyty-frontend'

export const Protocols = () => (
  <div className="flex flex-wrap items-center gap-2">
    <ProtocolBadge protocol="mcp" />
    <ProtocolBadge protocol="a2a" />
    <ProtocolBadge protocol="utcp" />
    <ProtocolBadge protocol="skills" />
    <ProtocolBadge protocol="soap" />
    <ProtocolBadge protocol="graphql" />
    <ProtocolBadge protocol="rest" />
  </div>
)

export const Interfaces = () => (
  <div className="flex flex-wrap items-center gap-2">
    <ProtocolBadge protocol="slack" />
    <ProtocolBadge protocol="discord" />
    <ProtocolBadge protocol="telegram" />
    <ProtocolBadge protocol="whatsapp" />
    <ProtocolBadge protocol="email" />
    <ProtocolBadge protocol="webhook" />
  </div>
)
