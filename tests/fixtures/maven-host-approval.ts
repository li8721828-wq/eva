export const mavenHostModule = 'approval-service'
export const hostHandlerPath = `${mavenHostModule}/src/main/java/pilot/ApprovalHandler.java`
export const hostTestClass = 'pilot.ApprovalHandlerTest'

export const hostReactorPom = `<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>pilot</groupId>
  <artifactId>host</artifactId>
  <version>1.0.0</version>
  <packaging>pom</packaging>
  <modules><module>${mavenHostModule}</module></modules>
</project>
`

export const hostModulePom = `<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>pilot</groupId>
  <artifactId>${mavenHostModule}</artifactId>
  <version>1.0.0</version>
  <properties>
    <maven.compiler.release>17</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
  <dependencies>
    <dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId><version>5.10.2</version><scope>test</scope></dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-resources-plugin</artifactId><version>3.3.1</version></plugin>
      <plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-compiler-plugin</artifactId><version>3.13.0</version></plugin>
      <plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-surefire-plugin</artifactId><version>3.2.5</version></plugin>
      <plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-jar-plugin</artifactId><version>3.4.2</version></plugin>
    </plugins>
  </build>
</project>
`

export const originalApprovalHandler = `package pilot;

import java.math.BigDecimal;
import java.util.UUID;
import java.util.function.Consumer;

public final class ApprovalHandler {
    public void submit(UUID id, BigDecimal total, boolean signed, Consumer<UUID> save) {
        if (total.compareTo(new BigDecimal("100000")) < 0 || !signed) {
            throw new IllegalArgumentException("Rejected");
        }
        save.accept(id);
    }
}
`

export const adaptedApprovalHandler = `package pilot;

import generated.sales.Order;
import generated.sales.OrderApproved;
import generated.sales.OrderWorkflow;
import java.math.BigDecimal;
import java.util.UUID;
import java.util.function.Consumer;

public final class ApprovalHandler {
    public void submit(UUID id, BigDecimal total, boolean signed, Consumer<UUID> save) {
        var order = new Order(id, total, signed);
        var decision = OrderWorkflow.apply(order, OrderWorkflow.State.Pending, OrderWorkflow.Command.Approve, "Finance");
        save.accept(((OrderApproved) decision.event()).id());
    }
}
`

export const approvalHandlerTests = `package pilot;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ApprovalHandlerTest {
    private final UUID id = new UUID(0, 42);
    private final BigDecimal threshold = new BigDecimal("100000.00");
    private final List<UUID> saved = new ArrayList<>();
    private final ApprovalHandler handler = new ApprovalHandler();

    @Test void unsignedOrderDoesNotReachPersistence() {
        assertThrows(IllegalArgumentException.class, () -> handler.submit(id, threshold, false, saved::add));
        assertTrue(saved.isEmpty());
    }

    @Test void approvedOrderReachesExistingPersistenceWithItsEventId() {
        handler.submit(id, threshold, true, saved::add);
        assertEquals(List.of(id), saved);
    }
}
`
