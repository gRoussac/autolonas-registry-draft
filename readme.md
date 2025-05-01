Service
│
├── ServiceAgentIdsIndex
│ └── Vec<AgentParamAccount>
│ ├── agent_id
│ ├── slots
│ └── bond
│
├── ServiceAgentInstancesIndex
│ └── Vec<Pubkey> ─────┐
│ ↓
├── ServiceAgentInstanceAccount
│ ├── service_id
│ ├── agent_id
│ └── agent_instance
│ ↑
│ └── referenced in OperatorAgentInstanceAccount
│
Operator
│
├── OperatorAgentInstanceIndex
│ └── Vec<Pubkey> ─────┐
│ ↓
├── OperatorAgentInstanceAccount
│ ├── operator
│ └── service_agent_instance (Pubkey of ServiceAgentInstanceAccount)
│
├── OperatorBondAccount
├── service_id
├── operator
└── bond
